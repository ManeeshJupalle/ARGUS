import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { EntityResolver } from '../resolver/entity-resolver';
import type { Poller } from '../scheduler/scheduler';

/**
 * LMArena poller — official HF dataset `lmarena-ai/leaderboard-dataset` via
 * the datasets-server API. Route chosen after live verification (2026-07-03):
 * the datasets-server /rows and /filter endpoints both work unauthenticated,
 * so the fallback mirror (api.wulong.dev) is NOT used. Facts observed live:
 *  - configs per modality: text_style_control, vision_style_control, webdev,
 *    text, vision, search, document, image/video ones. There is NO "code"
 *    config; text_style_control rows carry sub-categories instead
 *    ("overall", "coding", "math", "creative_writing", "hard_prompts", ...).
 *  - splits: `latest` (current board) and `full` (history since 2024-08-28;
 *    text/overall = 39,767 rows, vision/overall = 8,036, webdev/overall = 3,102).
 *  - /filter accepts simple equality where-clauses only (IN (...) → HTTP 422),
 *    100 rows per page.
 *  - row shape: model_name (slug-ish, dash-spelled versions, "-thinking"
 *    variants, embedded date stamps), organization, license, rating,
 *    rating_lower/upper, variance, vote_count (float), rank, category,
 *    leaderboard_publish_date ("YYYY-MM-DD").
 * arena_snapshot.ts stores leaderboard_publish_date verbatim; ci is
 * (rating_upper - rating_lower) / 2.
 */

const FILTER_URL = 'https://datasets-server.huggingface.co/filter';
const DATASET = 'lmarena-ai/leaderboard-dataset';
const PAGE = 100;
const PAGE_DELAY_MS = 150;
const USER_AGENT = 'ArgusTerminal/0.1 (local research tool)';

/** Config 'overall' boards map to these Argus category names. */
const BOARDS = [
  { config: 'text_style_control', overallAs: 'text' },
  { config: 'vision_style_control', overallAs: 'vision' },
  { config: 'webdev', overallAs: 'webdev' },
] as const;

/** Text sub-boards ingested daily under their raw category names. */
const TEXT_SUBCATS = ['coding', 'math', 'creative_writing', 'hard_prompts', 'instruction_following'];

/** History backfill runs while text history is thinner than this many dates. */
const BACKFILL_THRESHOLD_DATES = 30;
const BACKFILL_MAX_ROWS = 60_000;

const arenaRowSchema = z.object({
  model_name: z.string().min(1),
  organization: z.string(),
  license: z.string().nullish(), // observed string; tolerated null (unused — HF is the license source)
  rating: z.number(),
  rating_lower: z.number(),
  rating_upper: z.number(),
  vote_count: z.number(),
  rank: z.number(),
  category: z.string(),
  leaderboard_publish_date: z.string().min(1),
});

export interface ArenaIngestStats {
  rows: number;
  inserted: number;
  skippedMalformed: number;
  skippedUnresolved: number;
}

/**
 * Shared per-run resolution cache: model_name → canonical id (or null when
 * quarantined). One arena name is resolved once per poll, not once per row.
 */
export type ArenaResolutionCache = Map<string, string | null>;

function resolveArenaModel(
  resolver: EntityResolver,
  cache: ArenaResolutionCache,
  modelName: string,
  organization: string,
): string | null {
  const cached = cache.get(modelName);
  if (cached !== undefined) return cached;

  // Org-qualified attempt first (deterministic only), then org-less with
  // fuzzy fallback — arena names are the display-ish heterogeneous case the
  // resolver's fuzzy tier exists for.
  let res = resolver.resolve({ source: 'lmarena', raw: `${organization}/${modelName}`, allowFuzzy: false });
  if (res.status !== 'matched') {
    res = resolver.resolve({ source: 'lmarena', raw: modelName });
  }

  if (res.status === 'matched') {
    resolver.registerAlias(modelName, res.model_id);
    cache.set(modelName, res.model_id);
    return res.model_id;
  }
  const reason =
    res.status === 'ambiguous'
      ? `ambiguous between ${res.candidates.join(', ')}`
      : 'no resolution at or above fuzzy threshold';
  resolver.quarantine({ source: 'lmarena', raw: modelName }, reason, { organization });
  cache.set(modelName, null);
  return null;
}

/**
 * Ingest raw arena rows in one transaction. `categoryAs` maps the upstream
 * category ("overall") to the stored one ("text"/"vision"/"webdev").
 * Idempotent: PK (model_id, category, ts) + INSERT OR IGNORE.
 */
export function ingestArenaRows(
  db: Database.Database,
  resolver: EntityResolver,
  rows: unknown[],
  categoryAs: (upstreamCategory: string) => string,
  cache: ArenaResolutionCache,
): ArenaIngestStats {
  const stats: ArenaIngestStats = { rows: rows.length, inserted: 0, skippedMalformed: 0, skippedUnresolved: 0 };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO arena_snapshot (model_id, ts, category, elo, rank, ci, votes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const raw of rows) {
      const parsed = arenaRowSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        console.warn(`[lmarena] skipping malformed row: ${issue?.path.join('.')} ${issue?.message}`);
        stats.skippedMalformed++;
        continue;
      }
      const row = parsed.data;
      const modelId = resolveArenaModel(resolver, cache, row.model_name, row.organization);
      if (modelId === null) {
        stats.skippedUnresolved++;
        continue;
      }
      const result = insert.run(
        modelId,
        row.leaderboard_publish_date,
        categoryAs(row.category),
        row.rating,
        row.rank,
        (row.rating_upper - row.rating_lower) / 2,
        Math.round(row.vote_count),
      );
      stats.inserted += result.changes;
    }
  })();

  return stats;
}

const filterPageSchema = z.object({
  num_rows_total: z.number(),
  rows: z.array(z.object({ row: z.unknown() })),
});

async function fetchFilteredRows(
  config: string,
  split: 'latest' | 'full',
  category: string,
  maxRows: number,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let offset = 0;
  for (;;) {
    const url = new URL(FILTER_URL);
    url.searchParams.set('dataset', DATASET);
    url.searchParams.set('config', config);
    url.searchParams.set('split', split);
    url.searchParams.set('where', `"category"='${category}'`);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(PAGE));
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`datasets-server ${config}/${split}/${category} HTTP ${res.status}`);
    const page = filterPageSchema.parse(await res.json());
    rows.push(...page.rows.map((r) => r.row));
    offset += PAGE;
    if (offset >= Math.min(page.num_rows_total, maxRows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
  }
}

function distinctTextDates(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COUNT(DISTINCT ts) AS n FROM arena_snapshot WHERE category = 'text'`)
    .get() as { n: number };
  return row.n;
}

export function createArenaPoller(db: Database.Database, resolver: EntityResolver): Poller {
  return {
    name: 'lmarena',
    cadence: 24 * 60 * 60 * 1000,
    async run() {
      const cache: ArenaResolutionCache = new Map();
      const totals: ArenaIngestStats = { rows: 0, inserted: 0, skippedMalformed: 0, skippedUnresolved: 0 };
      const add = (s: ArenaIngestStats): void => {
        totals.rows += s.rows;
        totals.inserted += s.inserted;
        totals.skippedMalformed += s.skippedMalformed;
        totals.skippedUnresolved += s.skippedUnresolved;
      };

      // Current boards: each config's 'overall', plus text sub-categories.
      for (const board of BOARDS) {
        const rows = await fetchFilteredRows(board.config, 'latest', 'overall', BACKFILL_MAX_ROWS);
        add(ingestArenaRows(db, resolver, rows, () => board.overallAs, cache));
      }
      for (const cat of TEXT_SUBCATS) {
        const rows = await fetchFilteredRows('text_style_control', 'latest', cat, BACKFILL_MAX_ROWS);
        add(ingestArenaRows(db, resolver, rows, (c) => c, cache));
      }

      // One-time history backfill (text/overall ≈ 40k rows ≈ 400 pages; runs
      // until enough distinct dates exist, then never again). Sub-category
      // history is intentionally not backfilled — it accrues daily. PHASE-7
      // may revisit if ARENA CODE charts need deeper history.
      if (distinctTextDates(db) < BACKFILL_THRESHOLD_DATES) {
        console.log('[lmarena] history backfill starting (one-time, ~500 pages)');
        for (const board of BOARDS) {
          const rows = await fetchFilteredRows(board.config, 'full', 'overall', BACKFILL_MAX_ROWS);
          add(ingestArenaRows(db, resolver, rows, () => board.overallAs, cache));
        }
        console.log(`[lmarena] history backfill done: ${distinctTextDates(db)} distinct text dates`);
      }

      const matched = [...cache.values()].filter((v) => v !== null).length;
      console.log(
        `[lmarena] poll ok: ${totals.rows} rows, ${totals.inserted} snapshots inserted, ` +
          `${matched}/${cache.size} names resolved (${((matched / Math.max(cache.size, 1)) * 100).toFixed(1)}%), ` +
          `${totals.skippedUnresolved} rows quarantined-skipped, ${totals.skippedMalformed} malformed`,
      );
    },
  };
}
