import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalizeModelId, type EntityResolver } from '../resolver/entity-resolver';
import { assignTickers } from '../resolver/ticker';
import type { Poller } from '../scheduler/scheduler';

/**
 * OpenRouter poller — the market backbone (§4). Every field below is derived
 * from a real payload observed 2026-07-03 and saved to
 * server/fixtures/openrouter-models.json (340 models). Notable observations
 * vs the architecture doc:
 *  - pricing values are USD-per-TOKEN strings, e.g. "0.0000003"; the four
 *    openrouter/* router pseudo-models use "-1" as a variable-pricing sentinel
 *  - `canonical_slug` exists and is the DATED form ("...-20260630"); ":free"
 *    variants share the base entry's canonical_slug
 *  - no per-model provider count in the list payload (only via the
 *    per-model /endpoints link — one request per model, too costly), so
 *    price_snapshot.provider_count stays NULL
 *  - the `order` query param is IGNORED (top-weekly ≡ newest ≡ default
 *    created-desc; verified live), so weekly_tokens_rank stays NULL
 *  - `benchmarks.artificial_analysis` exposes numeric intelligence/coding/
 *    agentic indices, and `benchmarks.design_arena` per-category ELOs —
 *    both captured into bench_score
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const CADENCE_MS = 15 * 60 * 1000;

// Unknown keys are stripped by zod's default object behavior, so new upstream
// fields never break parsing; only wrong types/missing required fields do.
const orModelSchema = z.object({
  id: z.string().min(1),
  canonical_slug: z.string(),
  hugging_face_id: z.string().nullable(),
  name: z.string(),
  created: z.number(),
  context_length: z.number(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
  }),
  benchmarks: z
    .object({
      artificial_analysis: z
        .object({
          intelligence_index: z.number().nullable().optional(),
          coding_index: z.number().nullable().optional(),
          agentic_index: z.number().nullable().optional(),
        })
        .optional(),
      design_arena: z
        .array(
          z.object({
            arena: z.string(),
            category: z.string(),
            elo: z.number(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const orEnvelopeSchema = z.object({ data: z.array(z.unknown()) });

type OrModel = z.infer<typeof orModelSchema>;

export interface IngestStats {
  models: number;
  priceSnapshots: number;
  benchScores: number;
  skippedMalformed: number;
  skippedPseudo: number;
  tickersAssigned: number;
}

/**
 * Parse + resolve + write one observed payload in a single transaction.
 * One malformed model row is logged, quarantined, and skipped — it never
 * fails the whole poll. Idempotent: re-running with the same ts adds nothing.
 */
export function ingestOpenRouterModels(
  db: Database.Database,
  resolver: EntityResolver,
  payload: unknown,
  ts: string,
): IngestStats {
  const envelope = orEnvelopeSchema.parse(payload); // envelope failure = poll failure
  const stats: IngestStats = {
    models: 0,
    priceSnapshots: 0,
    benchScores: 0,
    skippedMalformed: 0,
    skippedPseudo: 0,
    tickersAssigned: 0,
  };

  const valid: OrModel[] = [];
  for (const [i, item] of envelope.data.entries()) {
    const parsed = orModelSchema.safeParse(item);
    if (!parsed.success) {
      const rawId =
        typeof (item as { id?: unknown } | null)?.id === 'string'
          ? (item as { id: string }).id
          : `<no id, index ${i}>`;
      const issue = parsed.error.issues[0];
      console.warn(
        `[openrouter] skipping malformed model ${rawId}: ${issue?.path.join('.')} ${issue?.message}`,
      );
      resolver.quarantine({ source: 'openrouter', raw: rawId }, `zod: ${issue?.path.join('.')} ${issue?.message}`, item);
      stats.skippedMalformed++;
      continue;
    }
    // Pseudo-entries, not models: "~org/x-latest" rolling aliases and
    // "openrouter/*" routers (which also carry the "-1" pricing sentinel).
    if (parsed.data.id.startsWith('~') || parsed.data.id.startsWith('openrouter/')) {
      stats.skippedPseudo++;
      continue;
    }
    valid.push(parsed.data);
  }

  // Group upstream entries by canonical entity: ":free"/":thinking" variants
  // and dated checkpoints collapse onto one model (§5 rules). The base entry
  // (id === canonical id) is the data donor; otherwise the newest member.
  const groups = new Map<string, OrModel[]>();
  for (const m of valid) {
    const canonical = canonicalizeModelId(m.id);
    const group = groups.get(canonical);
    if (group) group.push(m);
    else groups.set(canonical, [m]);
  }

  const upsertModel = db.prepare(
    `INSERT INTO model (id, ticker, name, author_org, license, openness, context_len, modalities, released_at, sources)
     VALUES (@id, NULL, @name, @author_org, @license, @openness, @context_len, @modalities, @released_at, @sources)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       author_org = excluded.author_org,
       -- never clobber a license the HF Hub poller enriched (OpenRouter has
       -- no license signal for open models — excluded.license is NULL there)
       license = COALESCE(model.license, excluded.license),
       openness = excluded.openness,
       context_len = excluded.context_len,
       modalities = excluded.modalities,
       released_at = excluded.released_at,
       sources = json_patch(model.sources, excluded.sources)`,
  );
  const insertPrice = db.prepare(
    `INSERT OR IGNORE INTO price_snapshot
       (model_id, ts, prompt_usd_per_mtok, completion_usd_per_mtok, provider_count, weekly_tokens_rank)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  );
  const upsertBench = db.prepare(
    `INSERT OR REPLACE INTO bench_score (model_id, benchmark, score, as_of, source) VALUES (?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const [canonical, members] of groups) {
      const donor =
        members.find((m) => m.id === canonical) ??
        members.reduce((a, b) => (b.created > a.created ? b : a));

      const resolution = resolver.resolve({
        source: 'openrouter',
        raw: donor.id,
        allowFuzzy: false,
        allowRules: false,
      });
      // 'ambiguous' cannot occur for org-qualified slugs with fuzzy off.
      const modelId = resolution.status === 'matched' ? resolution.model_id : canonical;

      upsertModel.run({
        id: modelId,
        name: cleanName(donor.name),
        author_org: modelId.split('/')[0] ?? '',
        // PHASE-3: the HF Hub poller enriches license for open models.
        license: isOpen(donor) ? null : 'proprietary',
        openness: isOpen(donor) ? 'open' : 'closed',
        context_len: donor.context_length,
        modalities: JSON.stringify(
          [...new Set([...donor.architecture.input_modalities, ...donor.architecture.output_modalities])],
        ),
        released_at: new Date(donor.created * 1000).toISOString(),
        // sources.hf (original case) is the HF Hub poller's direct join key.
        sources: JSON.stringify(
          isOpen(donor)
            ? { openrouter: donor.id, hf: donor.hugging_face_id }
            : { openrouter: donor.id },
        ),
      });
      stats.models++;

      const prompt = Number(donor.pricing.prompt);
      const completion = Number(donor.pricing.completion);
      if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
        insertPrice.run(modelId, ts, prompt * 1e6, completion * 1e6);
        stats.priceSnapshots++;
      }

      const asOf = ts.slice(0, 10);
      const aa = donor.benchmarks?.artificial_analysis;
      if (aa) {
        for (const key of ['intelligence_index', 'coding_index', 'agentic_index'] as const) {
          const score = aa[key];
          if (typeof score === 'number') {
            upsertBench.run(modelId, key, score, asOf, 'artificial_analysis');
            stats.benchScores++;
          }
        }
      }
      for (const entry of donor.benchmarks?.design_arena ?? []) {
        upsertBench.run(modelId, `${entry.arena}/${entry.category}`, entry.elo, asOf, 'design_arena');
        stats.benchScores++;
      }

      for (const member of members) {
        resolver.registerAlias(member.id, modelId);
        resolver.registerAlias(member.canonical_slug, modelId);
        resolver.registerAlias(cleanName(member.name), modelId);
        if (member.hugging_face_id) resolver.registerAlias(member.hugging_face_id, modelId);
      }
    }
    stats.tickersAssigned = assignTickers(db);
  })();

  return stats;
}

/** "Anthropic: Claude Fable 5" → "Claude Fable 5"; "X (free)" → "X". */
function cleanName(name: string): string {
  return name
    .replace(/^[^:]+:\s+/, '')
    .replace(/\s*\((free|beta|extended|thinking)\)$/i, '')
    .trim();
}

/** Openness inference: a linked HF repo means open weights (observed 163/340). */
function isOpen(m: OrModel): boolean {
  return typeof m.hugging_face_id === 'string' && m.hugging_face_id.length > 0;
}

export function createOpenRouterPoller(db: Database.Database, resolver: EntityResolver): Poller {
  return {
    name: 'openrouter',
    cadence: CADENCE_MS,
    async run() {
      const res = await fetch(OPENROUTER_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`openrouter HTTP ${res.status}`);
      const payload: unknown = await res.json();
      const stats = ingestOpenRouterModels(db, resolver, payload, new Date().toISOString());
      console.log(
        `[openrouter] poll ok: ${stats.models} models, ${stats.priceSnapshots} price snapshots, ` +
          `${stats.benchScores} bench scores, ${stats.tickersAssigned} tickers assigned, ` +
          `${stats.skippedMalformed} malformed skipped, ${stats.skippedPseudo} pseudo-entries skipped`,
      );
    },
  };
}
