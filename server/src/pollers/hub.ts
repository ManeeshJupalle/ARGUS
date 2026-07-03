import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { EntityResolver } from '../resolver/entity-resolver';
import { assignTickers } from '../resolver/ticker';
import type { Poller } from '../scheduler/scheduler';

/**
 * HF Hub poller — open-weight side of the market. Facts observed live
 * (2026-07-03, fixtures hf-models.json / hf-trending.json / hf-model-detail.json):
 *  - list endpoint returns an array (no envelope) of {_id, id, likes, private,
 *    downloads, tags[], pipeline_tag?, library_name?, createdAt, modelId};
 *    license lives in tags as "license:apache-2.0" (457/500 items).
 *  - the downloads-sorted list does NOT include trendingScore; a separate
 *    ?sort=trendingScore fetch does. trending_rank = position in that list.
 *  - the per-model detail endpoint (/api/models/{id}) has downloads, likes,
 *    tags, gated, cardData.license — but no trendingScore.
 * The list is filtered to pipeline_tag=text-generation: Argus tracks the LLM
 * market, not the embeddings/vision-encoder long tail.
 *
 * Join strategy per the entity model: model.sources.$.hf (recorded by the
 * OpenRouter poller from hugging_face_id) is the DIRECT key — those models
 * are fetched individually when absent from the top-500 list. List models
 * resolve via alias/exact only (allowFuzzy: false); unresolved list models
 * are CREATED as open-weight long-tail entities.
 */

const LIST_URL =
  'https://huggingface.co/api/models?pipeline_tag=text-generation&sort=downloads&direction=-1&limit=500';
const TRENDING_URL =
  'https://huggingface.co/api/models?pipeline_tag=text-generation&sort=trendingScore&direction=-1&limit=100';
const DETAIL_URL = 'https://huggingface.co/api/models/';
const DETAIL_DELAY_MS = 75;
const USER_AGENT = 'ArgusTerminal/0.1 (local research tool)';

const hubListItemSchema = z.object({
  id: z.string().min(1),
  downloads: z.number(),
  likes: z.number(),
  tags: z.array(z.string()),
  createdAt: z.string().optional(),
});

const hubDetailSchema = z.object({
  id: z.string().min(1),
  downloads: z.number(),
  likes: z.number(),
  tags: z.array(z.string()),
});

type HubItem = z.infer<typeof hubListItemSchema>;

function licenseFromTags(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith('license:'));
  return tag ? tag.slice('license:'.length) : null;
}

export interface HubIngestStats {
  snapshots: number;
  created: number;
  enrichedLicenses: number;
  skippedMalformed: number;
}

/**
 * Ingest one cycle of hub data in a single transaction. Trending ranks come
 * from the trending-sorted list (lowercased id → 1-based position).
 */
export function ingestHubModels(
  db: Database.Database,
  resolver: EntityResolver,
  listPayload: unknown,
  trendingPayload: unknown,
  ts: string,
): HubIngestStats {
  const stats: HubIngestStats = { snapshots: 0, created: 0, enrichedLicenses: 0, skippedMalformed: 0 };

  const parseItems = (payload: unknown, label: string): HubItem[] => {
    const arr = z.array(z.unknown()).parse(payload); // envelope failure = poll failure
    const items: HubItem[] = [];
    for (const raw of arr) {
      const parsed = hubListItemSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        console.warn(`[hf-hub] skipping malformed ${label} item: ${issue?.path.join('.')} ${issue?.message}`);
        stats.skippedMalformed++;
        continue;
      }
      items.push(parsed.data);
    }
    return items;
  };

  const listItems = parseItems(listPayload, 'list');
  const trendingRank = new Map<string, number>();
  parseItems(trendingPayload, 'trending').forEach((item, i) => {
    trendingRank.set(item.id.toLowerCase(), i + 1);
  });

  const insertSnapshot = db.prepare(
    `INSERT OR IGNORE INTO hub_snapshot (model_id, ts, downloads, likes, trending_rank)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const createModel = db.prepare(
    `INSERT INTO model (id, ticker, name, author_org, license, openness, context_len, modalities, released_at, sources)
     VALUES (?, NULL, ?, ?, ?, 'open', NULL, '["text"]', ?, ?)`,
  );
  const enrich = db.prepare(
    `UPDATE model SET license = ?, sources = json_patch(sources, ?) WHERE id = ?`,
  );

  db.transaction(() => {
    for (const item of listItems) {
      const res = resolver.resolve({ source: 'hf-hub', raw: item.id, allowFuzzy: false, allowRules: false });
      let modelId: string;
      if (res.status === 'matched') {
        modelId = res.model_id;
      } else {
        // Open-weight long tail: HF-only model becomes its own entity (§4).
        modelId = res.status === 'unmatched' ? res.canonical_id : item.id.toLowerCase();
        createModel.run(
          modelId,
          item.id.split('/').pop() ?? item.id,
          modelId.split('/')[0] ?? '',
          licenseFromTags(item.tags),
          item.createdAt ?? null,
          JSON.stringify({ hf: item.id }),
        );
        stats.created++;
      }
      const license = licenseFromTags(item.tags);
      if (license !== null) {
        enrich.run(license, JSON.stringify({ hf: item.id }), modelId);
        stats.enrichedLicenses++;
      }
      stats.snapshots += insertSnapshot.run(
        modelId,
        ts,
        item.downloads,
        item.likes,
        trendingRank.get(item.id.toLowerCase()) ?? null,
      ).changes;
    }
    assignTickers(db);
  })();

  return stats;
}

/** Models whose sources.$.hf is a direct HF join key (set by openrouter poller). */
function entityHfIds(db: Database.Database): { id: string; hf: string }[] {
  return db
    .prepare(
      `SELECT id, json_extract(sources, '$.hf') AS hf FROM model
       WHERE json_extract(sources, '$.hf') IS NOT NULL`,
    )
    .all() as { id: string; hf: string }[];
}

export function createHubPoller(db: Database.Database, resolver: EntityResolver): Poller {
  return {
    name: 'hf-hub',
    cadence: 60 * 60 * 1000,
    async run() {
      const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
      const [listRes, trendingRes] = await Promise.all([
        fetch(LIST_URL, { headers, signal: AbortSignal.timeout(30_000) }),
        fetch(TRENDING_URL, { headers, signal: AbortSignal.timeout(30_000) }),
      ]);
      if (!listRes.ok) throw new Error(`hf-hub list HTTP ${listRes.status}`);
      if (!trendingRes.ok) throw new Error(`hf-hub trending HTTP ${trendingRes.status}`);
      const listPayload: unknown = await listRes.json();
      const trendingPayload: unknown = await trendingRes.json();

      const ts = new Date().toISOString();
      const stats = ingestHubModels(db, resolver, listPayload, trendingPayload, ts);

      // Direct-key fetches: entity-table models with an HF id that the
      // top-500 list did not cover. Individual failures degrade that model
      // only, never the poll.
      const covered = new Set(
        z
          .array(z.unknown())
          .parse(listPayload)
          .map((raw) => {
            const item = hubListItemSchema.safeParse(raw);
            return item.success ? item.data.id.toLowerCase() : '';
          }),
      );
      const targets = entityHfIds(db).filter((t) => !covered.has(t.hf.toLowerCase()));
      const insertSnapshot = db.prepare(
        `INSERT OR IGNORE INTO hub_snapshot (model_id, ts, downloads, likes, trending_rank)
         VALUES (?, ?, ?, ?, NULL)`,
      );
      const setLicense = db.prepare(`UPDATE model SET license = ? WHERE id = ? AND license IS NULL`);
      let detailOk = 0;
      let detailFail = 0;
      for (const target of targets) {
        try {
          const res = await fetch(DETAIL_URL + target.hf, { headers, signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const detail = hubDetailSchema.parse(await res.json());
          insertSnapshot.run(target.id, ts, detail.downloads, detail.likes);
          const license = licenseFromTags(detail.tags);
          if (license !== null) setLicense.run(license, target.id);
          detailOk++;
        } catch (err) {
          detailFail++;
          console.warn(`[hf-hub] detail fetch failed for ${target.hf}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
      }

      console.log(
        `[hf-hub] poll ok: ${stats.snapshots + detailOk} hub snapshots (${detailOk}/${targets.length} direct-key), ` +
          `${stats.created} long-tail models created, ${stats.enrichedLicenses} licenses enriched, ` +
          `${detailFail} detail failures, ${stats.skippedMalformed} malformed skipped`,
      );
    },
  };
}
