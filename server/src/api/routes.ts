import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type {
  ArenaPoint,
  ArenaSeries,
  ArenaStanding,
  BenchCompare,
  BenchCompareModel,
  BenchCompareRow,
  BenchScore,
  Envelope,
  Frontier,
  FrontierPoint,
  FrontierSide,
  Leaderboard,
  LeaderboardRow,
  MarketRow,
  Model,
  ModelDetail,
  NewsItem,
  Openness,
  Overview,
  PricePoint,
  SearchResult,
  StatPayload,
  StatSource,
  WatchQuote,
} from '@argus/shared';
import { getSourceStatuses } from '../db/db';

/**
 * PHASE-4 read API (§6). Read-only: nothing in this module writes to the DB.
 * Every query param is zod-parsed; bad input → 400 {error}, unknown entity →
 * 404 {error}. Successful responses use the §6 envelope {data, asOf, stale?}
 * (stale included only when true).
 *
 * Canonical model ids are always org/name, so entity routes take two path
 * segments (/api/models/:org/:name...) — no URL-encoding gymnastics.
 */

/* ------------------------------- staleness ------------------------------- */

/**
 * A source is unhealthy when it has never succeeded, is currently failing,
 * or its last success is older than 3x its poll cadence. On a freshly
 * seeded offline DB every source reports stale — that's honest: the data is
 * fixture-age, and the flag clears within seconds of the first live poll.
 */
const STALE_CADENCE_FACTOR = 3;

type StatusRow = { last_success: string | null; consecutive_failures: number };

class StaleTracker {
  constructor(
    private readonly db: Database.Database,
    private readonly cadences: Map<string, number>,
  ) {}

  private unhealthy(source: string): boolean {
    const row = this.db
      .prepare(`SELECT last_success, consecutive_failures FROM source_status WHERE source = ?`)
      .get(source) as StatusRow | undefined;
    if (!row || row.last_success === null || row.consecutive_failures > 0) return true;
    const cadence = this.cadences.get(source);
    if (cadence === undefined) return true;
    return Date.now() - Date.parse(row.last_success) > cadence * STALE_CADENCE_FACTOR;
  }

  /** Stale if ANY of the sources is unhealthy (single-source data). */
  any(sources: string[]): boolean {
    return sources.some((s) => this.unhealthy(s));
  }

  /** Stale only if ALL sources are unhealthy (multi-source feeds: news). */
  all(sources: string[]): boolean {
    return sources.length > 0 && sources.every((s) => this.unhealthy(s));
  }

  newsSources(): string[] {
    return [...this.cadences.keys()].filter(
      (s) => s === 'hn' || s === 'arxiv' || s.startsWith('rss:'),
    );
  }
}

/* -------------------------------- helpers -------------------------------- */

function ok<T>(c: Context, data: T, asOf: string, stale: boolean): Response {
  const body: Envelope<T> = stale ? { data, asOf, stale } : { data, asOf };
  return c.json(body);
}

function badRequest(c: Context, error: z.ZodError | string): Response {
  const message =
    typeof error === 'string'
      ? error
      : error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return c.json({ error: message }, 400);
}

const RANGE_DAYS = { '30d': 30, '90d': 90, max: null } as const;
const rangeSchema = z.enum(['30d', '90d', 'max']).default('max');

/** ISO cutoff for a range, or null for max. Arena ts is date-only, so the
 * date-only prefix of an ISO string compares correctly against both forms. */
function rangeCutoff(range: keyof typeof RANGE_DAYS): string | null {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

interface DbModelRow {
  id: string;
  ticker: string | null;
  name: string;
  author_org: string;
  license: string | null;
  openness: Openness;
  context_len: number | null;
  modalities: string;
  released_at: string | null;
  sources: string;
}

function parseModel(row: DbModelRow): Model {
  return {
    ...row,
    modalities: JSON.parse(row.modalities) as string[],
    sources: JSON.parse(row.sources) as Record<string, string>,
  };
}

interface DbNewsRow {
  id: string;
  ts: string;
  source: string;
  title: string;
  url: string;
  summary: string | null;
  salience: number | null;
  model_ids: string;
  org: string | null;
}

function parseNews(row: DbNewsRow): NewsItem {
  return { ...row, model_ids: JSON.parse(row.model_ids) as string[] };
}

/* --------------------------------- routes -------------------------------- */

export function registerApiRoutes(
  app: Hono,
  db: Database.Database,
  cadences: Map<string, number>,
): void {
  const staleness = new StaleTracker(db, cadences);
  const now = (): string => new Date().toISOString();

  /* ---- GET /api/status — Phase-1 endpoint, enriched in PHASE-5 with the
     computed per-source `stale` flag so the status-bar dots use the exact
     same rule as the response envelopes (the client can't know cadences). */

  app.get('/api/status', (c) => {
    const rows = getSourceStatuses(db).map((s) => ({
      ...s,
      stale: staleness.any([s.source]),
    }));
    return c.json(rows);
  });

  /* ---- GET /api/models — the market table ---- */

  // Whitelisted sort → (SQL expression, natural direction). `dir` overrides.
  const SORTS = {
    price: ['p.prompt_usd_per_mtok', 'ASC'],
    context: ['m.context_len', 'DESC'],
    elo: ['a.elo', 'DESC'],
    intelligence: ['b.score', 'DESC'],
    newest: ['m.released_at', 'DESC'],
  } as const;

  const modelsQuery = z.object({
    filter: z.enum(['open', 'closed']).optional(),
    sort: z.enum(['price', 'context', 'elo', 'intelligence', 'newest']).default('elo'),
    dir: z.enum(['asc', 'desc']).optional(),
  });

  app.get('/api/models', (c) => {
    const parsed = modelsQuery.safeParse(c.req.query());
    if (!parsed.success) return badRequest(c, parsed.error);
    const { filter, sort, dir } = parsed.data;
    const [expr, natural] = SORTS[sort];
    const direction = dir?.toUpperCase() ?? natural;

    // SQLite "bare columns with MAX" selects the values from the max-ts row,
    // giving latest-per-model joins without correlated subqueries.
    const rows = db
      .prepare(
        `SELECT m.id, m.ticker, m.name, m.author_org, m.openness, m.license,
                m.context_len, m.released_at,
                p.prompt_usd_per_mtok, p.completion_usd_per_mtok,
                a.elo, a.rank AS arena_rank,
                b.score AS intelligence_index,
                h.downloads
         FROM model m
         LEFT JOIN (SELECT model_id, prompt_usd_per_mtok, completion_usd_per_mtok, MAX(ts)
                    FROM price_snapshot GROUP BY model_id) p ON p.model_id = m.id
         LEFT JOIN (SELECT model_id, elo, rank, MAX(ts)
                    FROM arena_snapshot WHERE category = 'text' GROUP BY model_id) a ON a.model_id = m.id
         LEFT JOIN (SELECT model_id, score, MAX(as_of)
                    FROM bench_score WHERE benchmark = 'intelligence_index' AND source = 'artificial_analysis'
                    GROUP BY model_id) b ON b.model_id = m.id
         LEFT JOIN (SELECT model_id, downloads, MAX(ts)
                    FROM hub_snapshot GROUP BY model_id) h ON h.model_id = m.id
         ${filter ? 'WHERE m.openness = ?' : ''}
         ORDER BY ${expr} ${direction} NULLS LAST, m.id ASC`,
      )
      .all(...(filter ? [filter] : [])) as MarketRow[];

    return ok(c, rows, now(), staleness.any(['openrouter']));
  });

  /* ---- GET /api/models/:org/:name — the DES payload ---- */

  app.get('/api/models/:org/:name', (c) => {
    const id = `${c.req.param('org')}/${c.req.param('name')}`.toLowerCase();
    const row = db.prepare(`SELECT * FROM model WHERE id = ?`).get(id) as DbModelRow | undefined;
    if (!row) return c.json({ error: `unknown model: ${id}` }, 404);

    const aliases = (
      db.prepare(`SELECT alias FROM entity_alias WHERE model_id = ? ORDER BY alias`).all(id) as {
        alias: string;
      }[]
    ).map((r) => r.alias);

    const pricing = db
      .prepare(
        `SELECT ts, prompt_usd_per_mtok, completion_usd_per_mtok, MAX(ts)
         FROM price_snapshot WHERE model_id = ?`,
      )
      .get(id) as (PricePoint & { ts: string | null }) | undefined;

    const arena = db
      .prepare(
        `SELECT category, elo, rank, ci, votes, MAX(ts) AS ts
         FROM arena_snapshot WHERE model_id = ? GROUP BY category ORDER BY category`,
      )
      .all(id) as ArenaStanding[];

    const bench = db
      .prepare(
        `SELECT model_id, benchmark, score, source, MAX(as_of) AS as_of
         FROM bench_score WHERE model_id = ? GROUP BY benchmark, source ORDER BY source, benchmark`,
      )
      .all(id) as BenchScore[];

    const hub = db
      .prepare(
        `SELECT ts, downloads, likes, trending_rank, MAX(ts)
         FROM hub_snapshot WHERE model_id = ?`,
      )
      .get(id) as { ts: string | null; downloads: number; likes: number; trending_rank: number | null } | undefined;

    const news = (
      db
        .prepare(
          `SELECT * FROM news_item n
           WHERE EXISTS (SELECT 1 FROM json_each(n.model_ids) je WHERE je.value = ?)
           ORDER BY n.ts DESC LIMIT 10`,
        )
        .all(id) as DbNewsRow[]
    ).map(parseNews);

    const data: ModelDetail = {
      model: parseModel(row),
      aliases,
      pricing:
        pricing && pricing.ts !== null
          ? {
              ts: pricing.ts,
              prompt_usd_per_mtok: pricing.prompt_usd_per_mtok,
              completion_usd_per_mtok: pricing.completion_usd_per_mtok,
            }
          : null,
      arena,
      bench,
      hub: hub && hub.ts !== null ? { ts: hub.ts, downloads: hub.downloads, likes: hub.likes, trending_rank: hub.trending_rank } : null,
      news,
    };
    return ok(c, data, now(), staleness.any(['openrouter', 'lmarena', 'hf-hub']));
  });

  /* ---- GET /api/models/:org/:name/prices ---- */

  const pricesQuery = z.object({ range: rangeSchema });

  app.get('/api/models/:org/:name/prices', (c) => {
    const parsed = pricesQuery.safeParse(c.req.query());
    if (!parsed.success) return badRequest(c, parsed.error);
    const id = `${c.req.param('org')}/${c.req.param('name')}`.toLowerCase();
    if (!modelExists(db, id)) return c.json({ error: `unknown model: ${id}` }, 404);

    const cutoff = rangeCutoff(parsed.data.range);
    const points = db
      .prepare(
        `SELECT ts, prompt_usd_per_mtok, completion_usd_per_mtok FROM price_snapshot
         WHERE model_id = ? ${cutoff ? 'AND ts >= ?' : ''} ORDER BY ts ASC`,
      )
      .all(...(cutoff ? [id, cutoff] : [id])) as PricePoint[];

    const last = points[points.length - 1];
    return ok(c, points, last?.ts ?? now(), staleness.any(['openrouter']));
  });

  /* ---- GET /api/models/:org/:name/arena ---- */

  const arenaSeriesQuery = z.object({
    category: z.string().min(1).default('text'),
    range: rangeSchema,
  });

  app.get('/api/models/:org/:name/arena', (c) => {
    const parsed = arenaSeriesQuery.safeParse(c.req.query());
    if (!parsed.success) return badRequest(c, parsed.error);
    const id = `${c.req.param('org')}/${c.req.param('name')}`.toLowerCase();
    if (!modelExists(db, id)) return c.json({ error: `unknown model: ${id}` }, 404);

    const { category, range } = parsed.data;
    const cutoff = rangeCutoff(range);
    const points = db
      .prepare(
        `SELECT ts, elo, rank, ci, votes FROM arena_snapshot
         WHERE model_id = ? AND category = ? ${cutoff ? 'AND ts >= ?' : ''} ORDER BY ts ASC`,
      )
      .all(...(cutoff ? [id, category, cutoff] : [id, category])) as ArenaPoint[];

    const data: ArenaSeries = { category, points };
    const last = points[points.length - 1];
    return ok(c, data, last?.ts ?? now(), staleness.any(['lmarena']));
  });

  /* ---- GET /api/arena/leaderboard ---- */

  const leaderboardQuery = z.object({ category: z.string().min(1).default('text') });

  app.get('/api/arena/leaderboard', (c) => {
    const parsed = leaderboardQuery.safeParse(c.req.query());
    if (!parsed.success) return badRequest(c, parsed.error);
    const { category } = parsed.data;
    const data = buildLeaderboard(db, category);
    return ok(c, data, data.board_date ?? now(), staleness.any(['lmarena']));
  });

  /* ---- GET /api/bench/compare?ids=a,b,c ---- */

  const compareQuery = z.object({
    ids: z
      .string()
      .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
      .refine((ids) => ids.length >= 2 && ids.length <= 5, 'ids must list 2-5 model ids'),
  });

  app.get('/api/bench/compare', (c) => {
    const parsed = compareQuery.safeParse(c.req.query());
    if (!parsed.success) return badRequest(c, parsed.error);
    const ids = parsed.data.ids;

    const models = ids.map((id) =>
      db
        .prepare(`SELECT id, ticker, name, openness FROM model WHERE id = ?`)
        .get(id) as BenchCompareModel | undefined,
    );
    const unknown = ids.filter((_, i) => models[i] === undefined);
    if (unknown.length > 0) return badRequest(c, `unknown model ids: ${unknown.join(', ')}`);
    const found = models as BenchCompareModel[];

    // Synthetic headline rows first (arena ELOs per category, price, context),
    // then every benchmark any of the models has a score for. Missing cells
    // are null — never fabricated.
    const rows: BenchCompareRow[] = [];
    const numberPerModel = (fn: (id: string) => number | null): (number | null)[] =>
      found.map((m) => fn(m.id));

    // PHASE-6: one row per arena category any compared model appears in
    // ('text' pinned first — it's the headline board).
    const cats = (
      db
        .prepare(
          `SELECT DISTINCT category FROM arena_snapshot
           WHERE model_id IN (${ids.map(() => '?').join(',')}) ORDER BY category`,
        )
        .all(...ids) as { category: string }[]
    )
      .map((r) => r.category)
      .sort((a, b) => (a === 'text' ? -1 : b === 'text' ? 1 : a.localeCompare(b)));
    for (const cat of cats) {
      rows.push({
        key: `arena_elo_${cat}`,
        source: 'lmarena',
        values: numberPerModel((id) => {
          const r = db
            .prepare(`SELECT elo, MAX(ts) FROM arena_snapshot WHERE model_id = ? AND category = ?`)
            .get(id, cat) as { elo: number | null } | undefined;
          return r?.elo ?? null;
        }),
      });
    }
    const latestPrice = (id: string): { prompt: number; completion: number } | null => {
      const r = db
        .prepare(
          `SELECT prompt_usd_per_mtok AS prompt, completion_usd_per_mtok AS completion, MAX(ts) AS ts
           FROM price_snapshot WHERE model_id = ?`,
        )
        .get(id) as { prompt: number; completion: number; ts: string | null } | undefined;
      return r && r.ts !== null ? r : null;
    };
    rows.push({
      key: 'prompt_usd_per_mtok',
      source: 'openrouter',
      values: numberPerModel((id) => latestPrice(id)?.prompt ?? null),
    });
    rows.push({
      key: 'completion_usd_per_mtok',
      source: 'openrouter',
      values: numberPerModel((id) => latestPrice(id)?.completion ?? null),
    });
    rows.push({
      key: 'context_len',
      source: 'model',
      values: found.map((m) => {
        const r = db.prepare(`SELECT context_len FROM model WHERE id = ?`).get(m.id) as {
          context_len: number | null;
        };
        return r.context_len;
      }),
    });

    const benchKeys = db
      .prepare(
        `SELECT DISTINCT benchmark, source FROM bench_score
         WHERE model_id IN (${ids.map(() => '?').join(',')})
         ORDER BY source, benchmark`,
      )
      .all(...ids) as { benchmark: string; source: string }[];
    for (const { benchmark, source } of benchKeys) {
      rows.push({
        key: benchmark,
        source,
        values: numberPerModel((id) => {
          const r = db
            .prepare(
              `SELECT score, MAX(as_of) FROM bench_score
               WHERE model_id = ? AND benchmark = ? AND source = ?`,
            )
            .get(id, benchmark, source) as { score: number | null } | undefined;
          return r?.score ?? null;
        }),
      });
    }

    const data: BenchCompare = { models: found, rows };
    return ok(c, data, now(), staleness.any(['openrouter', 'lmarena']));
  });

  /* ---- GET /api/news ---- */

  const newsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    model: z.string().min(1).optional(),
  });

  app.get('/api/news', (c) => {
    const parsed = newsQuery.safeParse(c.req.query());
    if (!parsed.success) return badRequest(c, parsed.error);
    const { limit, model } = parsed.data;

    const rows = (
      model
        ? db
            .prepare(
              `SELECT * FROM news_item n
               WHERE EXISTS (SELECT 1 FROM json_each(n.model_ids) je WHERE je.value = ?)
               ORDER BY n.ts DESC LIMIT ?`,
            )
            .all(model.toLowerCase(), limit)
        : db.prepare(`SELECT * FROM news_item ORDER BY ts DESC LIMIT ?`).all(limit)
    ) as DbNewsRow[];

    return ok(c, rows.map(parseNews), now(), staleness.all(staleness.newsSources()));
  });

  /* ---- GET /api/overview — the TOP payload ---- */

  app.get('/api/overview', (c) => {
    const data = buildOverview(db, staleness);
    return ok(c, data, now(), staleness.any(['openrouter', 'lmarena', 'hf-hub']));
  });

  /* ---- GET /api/search — command-line autocomplete ---- */

  const searchQuery = z.object({ q: z.string().min(1) });

  app.get('/api/search', (c) => {
    const parsed = searchQuery.safeParse(c.req.query());
    if (!parsed.success) return badRequest(c, parsed.error);
    return ok(c, search(db, parsed.data.q), now(), false);
  });

  /* ---- GET /api/stat — PHASE-7 plumbing-on-display (STAT panel) ---- */

  /** source_status name → the table its rows land in. */
  const SOURCE_ROWS: Record<string, { table: string; where?: string }> = {
    openrouter: { table: 'price_snapshot' },
    lmarena: { table: 'arena_snapshot' },
    'hf-hub': { table: 'hub_snapshot' },
  };

  app.get('/api/stat', (c) => {
    const count = (sql: string, ...params: unknown[]): number =>
      (db.prepare(sql).get(...params) as { n: number }).n;

    const sources: StatSource[] = getSourceStatuses(db)
      .filter((s) => s.source !== 'heartbeat')
      .map((s) => {
        const mapped = SOURCE_ROWS[s.source];
        const rows = mapped
          ? count(`SELECT COUNT(*) AS n FROM ${mapped.table}`)
          : s.source === 'hn' || s.source === 'arxiv' || s.source.startsWith('rss:')
            ? count(`SELECT COUNT(*) AS n FROM news_item WHERE source = ?`, s.source)
            : null;
        return {
          source: s.source,
          cadence_ms: cadences.get(s.source) ?? null,
          stale: staleness.any([s.source]),
          last_success: s.last_success,
          last_error: s.last_error,
          consecutive_failures: s.consecutive_failures,
          rows,
          quarantined: count(`SELECT COUNT(*) AS n FROM quarantine WHERE source = ?`, s.source),
        };
      });

    const span = db
      .prepare(
        `SELECT MIN(ts) AS min, MAX(ts) AS max, COUNT(DISTINCT ts) AS dates FROM arena_snapshot`,
      )
      .get() as { min: string | null; max: string | null; dates: number };

    const data: StatPayload = {
      sources,
      totals: {
        models: count(`SELECT COUNT(*) AS n FROM model`),
        open_models: count(`SELECT COUNT(*) AS n FROM model WHERE openness = 'open'`),
        price_snapshots: count(`SELECT COUNT(*) AS n FROM price_snapshot`),
        arena_snapshots: count(`SELECT COUNT(*) AS n FROM arena_snapshot`),
        hub_snapshots: count(`SELECT COUNT(*) AS n FROM hub_snapshot`),
        bench_scores: count(`SELECT COUNT(*) AS n FROM bench_score`),
        news_items: count(`SELECT COUNT(*) AS n FROM news_item`),
        aliases: count(`SELECT COUNT(*) AS n FROM entity_alias`),
        quarantined: count(`SELECT COUNT(*) AS n FROM quarantine`),
        watchlist: count(`SELECT COUNT(*) AS n FROM watchlist`),
      },
      arena_span: { min: span.min, max: span.max, distinct_dates: span.dates },
    };
    return ok(c, data, now(), false);
  });

  /* ---- watchlist (PHASE-6) ------------------------------------------------
     THE ONLY WRITE ENDPOINTS IN THE APP. Single-user §7 WATCH persistence:
       GET    /api/watchlist            → live quote board (computed, read-only)
       POST   /api/watchlist            → body {model_id}; idempotent add
       DELETE /api/watchlist/:org/:name → idempotent remove
     Everything else in this module stays strictly read-only. */

  app.get('/api/watchlist', (c) => {
    const watched = db
      .prepare(`SELECT model_id, added_at FROM watchlist ORDER BY added_at ASC`)
      .all() as { model_id: string; added_at: string }[];

    const board = buildLeaderboard(db, 'text');
    const eloByModel = new Map(board.rows.map((r) => [r.id, r]));

    const priceSeries = db
      .prepare(
        `SELECT model_id, ts, prompt_usd_per_mtok AS value FROM price_snapshot
         WHERE model_id IN (SELECT model_id FROM watchlist) ORDER BY model_id, ts ASC`,
      )
      .all() as TsValue[];
    const day = deltas(priceSeries, 24 * 3600_000, 30 * 86_400_000);
    const week = deltas(priceSeries, 7 * 86_400_000, 30 * 86_400_000);
    const pct = (cur: number, prev: number | null): number | null =>
      prev === null || prev === 0 ? null : ((cur - prev) / prev) * 100;

    const data: WatchQuote[] = watched.map((w) => {
      const model = db
        .prepare(`SELECT id, ticker, name, openness FROM model WHERE id = ?`)
        .get(w.model_id) as Pick<Model, 'id' | 'ticker' | 'name' | 'openness'>;
      const price = day.get(w.model_id);
      const arena = eloByModel.get(w.model_id);
      return {
        ...model,
        added_at: w.added_at,
        prompt_usd_per_mtok: price?.current ?? null,
        price_delta_pct_24h: price ? pct(price.current, price.prev) : null,
        price_delta_pct_7d: (() => {
          const wk = week.get(w.model_id);
          return wk ? pct(wk.current, wk.prev) : null;
        })(),
        elo: arena?.elo ?? null,
        arena_rank: arena?.rank ?? null,
        elo_delta_7d: arena?.elo_delta_7d ?? null,
      };
    });
    return ok(c, data, now(), staleness.any(['openrouter', 'lmarena']));
  });

  const watchAddBody = z.object({ model_id: z.string().min(1) });

  app.post('/api/watchlist', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badRequest(c, 'expected JSON body {model_id}');
    }
    const parsed = watchAddBody.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error);
    const id = parsed.data.model_id.toLowerCase();
    if (!modelExists(db, id)) return c.json({ error: `unknown model: ${id}` }, 404);
    db.prepare(`INSERT OR IGNORE INTO watchlist (model_id, added_at) VALUES (?, ?)`).run(
      id,
      now(),
    );
    return c.json({ ok: true, model_id: id }, 201);
  });

  app.delete('/api/watchlist/:org/:name', (c) => {
    const id = `${c.req.param('org')}/${c.req.param('name')}`.toLowerCase();
    db.prepare(`DELETE FROM watchlist WHERE model_id = ?`).run(id);
    return c.json({ ok: true, model_id: id });
  });
}

function modelExists(db: Database.Database, id: string): boolean {
  return db.prepare(`SELECT 1 FROM model WHERE id = ?`).get(id) !== undefined;
}

/* ------------------------------ leaderboard ------------------------------ */

function buildLeaderboard(db: Database.Database, category: string): Leaderboard {
  const latest = (
    db.prepare(`SELECT MAX(ts) AS ts FROM arena_snapshot WHERE category = ?`).get(category) as {
      ts: string | null;
    }
  ).ts;
  if (latest === null) return { category, board_date: null, prior_date: null, rows: [] };

  // The board the 7d deltas compare against: the newest board at least 7
  // days older than the current one (arena ts is a date string).
  const prior = (
    db
      .prepare(
        `SELECT MAX(ts) AS ts FROM arena_snapshot WHERE category = ? AND ts <= date(?, '-7 day')`,
      )
      .get(category, latest) as { ts: string | null }
  ).ts;

  const priorByModel = new Map<string, { elo: number; rank: number }>();
  if (prior !== null) {
    const rows = db
      .prepare(`SELECT model_id, elo, rank FROM arena_snapshot WHERE category = ? AND ts = ?`)
      .all(category, prior) as { model_id: string; elo: number; rank: number }[];
    for (const r of rows) priorByModel.set(r.model_id, { elo: r.elo, rank: r.rank });
  }

  const rows = (
    db
      .prepare(
        `SELECT a.rank, m.id, m.ticker, m.name, m.openness, a.elo, a.ci, a.votes
         FROM arena_snapshot a JOIN model m ON m.id = a.model_id
         WHERE a.category = ? AND a.ts = ? ORDER BY a.rank ASC, a.elo DESC`,
      )
      .all(category, latest) as Omit<LeaderboardRow, 'elo_delta_7d' | 'rank_delta_7d'>[]
  ).map((r): LeaderboardRow => {
    const p = priorByModel.get(r.id);
    return {
      ...r,
      elo_delta_7d: p ? r.elo - p.elo : null,
      rank_delta_7d: p ? p.rank - r.rank : null,
    };
  });

  return { category, board_date: latest, prior_date: prior, rows };
}

/* -------------------------------- overview ------------------------------- */

interface TsValue {
  model_id: string;
  ts: string;
  value: number;
}

/** Latest value per model plus the newest value at least `minAgeMs` older
 * (bounded to `windowMs` back). Series must be ordered model_id, ts ASC. */
function deltas(
  series: TsValue[],
  minAgeMs: number,
  windowMs: number,
): Map<string, { current: number; prev: number | null }> {
  const byModel = new Map<string, TsValue[]>();
  for (const row of series) {
    const arr = byModel.get(row.model_id);
    if (arr) arr.push(row);
    else byModel.set(row.model_id, [row]);
  }
  const out = new Map<string, { current: number; prev: number | null }>();
  for (const [id, rows] of byModel) {
    const last = rows[rows.length - 1];
    if (!last) continue;
    const lastMs = Date.parse(last.ts);
    let prev: TsValue | null = null;
    for (let i = rows.length - 2; i >= 0; i--) {
      const r = rows[i];
      if (!r) continue;
      const age = lastMs - Date.parse(r.ts);
      if (age > windowMs) break;
      if (age >= minAgeMs) {
        prev = r;
        break;
      }
    }
    out.set(id, { current: last.value, prev: prev?.value ?? null });
  }
  return out;
}

function buildOverview(db: Database.Database, staleness: StaleTracker): Overview {
  const nameOf = new Map<string, { ticker: string | null; name: string }>();
  for (const m of db.prepare(`SELECT id, ticker, name FROM model`).all() as {
    id: string;
    ticker: string | null;
    name: string;
  }[]) {
    nameOf.set(m.id, { ticker: m.ticker, name: m.name });
  }
  const named = (id: string): { id: string; ticker: string | null; name: string } => ({
    id,
    ticker: nameOf.get(id)?.ticker ?? null,
    name: nameOf.get(id)?.name ?? id,
  });

  /* stats */
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS models,
              SUM(openness = 'open') AS open,
              SUM(openness = 'closed') AS closed
       FROM model`,
    )
    .get() as { models: number; open: number; closed: number };
  const statuses = getSourceStatuses(db).filter((s) => s.source !== 'heartbeat');
  const healthy = statuses.filter((s) => !staleness.any([s.source])).length;

  /* price movers: latest prompt price vs ≥24h-old and ≥7d-old snapshots */
  const priceSeries = db
    .prepare(
      `SELECT model_id, ts, prompt_usd_per_mtok AS value FROM price_snapshot ORDER BY model_id, ts ASC`,
    )
    .all() as TsValue[];
  const day = deltas(priceSeries, 24 * 3600_000, 30 * 86_400_000);
  const week = deltas(priceSeries, 7 * 86_400_000, 30 * 86_400_000);
  const pct = (cur: number, prev: number | null): number | null =>
    prev === null || prev === 0 ? null : ((cur - prev) / prev) * 100;
  const priceMovers = [...day.entries()]
    .map(([id, d]) => ({
      ...named(id),
      prompt_usd_per_mtok: d.current,
      delta_pct_24h: pct(d.current, d.prev),
      delta_pct_7d: pct(d.current, week.get(id)?.prev ?? null),
    }))
    .filter((m) => (m.delta_pct_24h ?? 0) !== 0 || (m.delta_pct_7d ?? 0) !== 0)
    .sort(
      (a, b) =>
        Math.max(Math.abs(b.delta_pct_24h ?? 0), Math.abs(b.delta_pct_7d ?? 0)) -
        Math.max(Math.abs(a.delta_pct_24h ?? 0), Math.abs(a.delta_pct_7d ?? 0)),
    )
    .slice(0, 5);

  /* arena movers: current text board vs the ≥7d-older board */
  const board = buildLeaderboard(db, 'text');
  const arenaMovers = board.rows
    .filter((r) => r.rank_delta_7d !== null && r.rank_delta_7d !== 0)
    .map((r) => ({
      id: r.id,
      ticker: r.ticker,
      name: r.name,
      rank: r.rank,
      elo: r.elo,
      rank_delta_7d: r.rank_delta_7d as number,
      elo_delta_7d: (r.elo_delta_7d ?? 0) as number,
    }))
    .sort(
      (a, b) =>
        Math.abs(b.rank_delta_7d) - Math.abs(a.rank_delta_7d) ||
        Math.abs(b.elo_delta_7d) - Math.abs(a.elo_delta_7d),
    )
    .slice(0, 8);

  /* download spikes: change across the trailing 7d window (needs ≥24h of
   * hub history to appear — hourly snapshots accrue it within a day) */
  const hubSeries = db
    .prepare(`SELECT model_id, ts, downloads AS value FROM hub_snapshot ORDER BY model_id, ts ASC`)
    .all() as TsValue[];
  const hubDeltas = deltas(hubSeries, 24 * 3600_000, 7 * 86_400_000);
  const downloadSpikes = [...hubDeltas.entries()]
    .filter(([, d]) => d.prev !== null && d.prev > 1000 && d.current !== d.prev)
    .map(([id, d]) => ({
      ...named(id),
      downloads: d.current,
      delta_7d: d.current - (d.prev as number),
      delta_pct_7d: pct(d.current, d.prev) as number,
    }))
    .sort((a, b) => Math.abs(b.delta_pct_7d) - Math.abs(a.delta_pct_7d))
    .slice(0, 5);

  /* newest models */
  const newest = db
    .prepare(
      `SELECT id, ticker, name, openness, released_at FROM model
       WHERE released_at IS NOT NULL ORDER BY released_at DESC LIMIT 8`,
    )
    .all() as Overview['newest'];

  /* latest news */
  const news = (
    db.prepare(`SELECT * FROM news_item ORDER BY ts DESC LIMIT 10`).all() as DbNewsRow[]
  ).map(parseNews);

  /* frontier gap: best open ELO minus best closed ELO, text, with trend */
  const frontier = buildFrontier(db);

  return {
    stats: {
      models: counts.models,
      open: counts.open,
      closed: counts.closed,
      sources_total: statuses.length,
      sources_healthy: healthy,
    },
    price_movers: priceMovers,
    arena_movers: arenaMovers,
    download_spikes: downloadSpikes,
    newest,
    news,
    frontier,
  };
}

function buildFrontier(db: Database.Database): Frontier {
  const side = (openness: Openness): FrontierSide | null =>
    (db
      .prepare(
        `SELECT m.id, m.ticker, a.elo
         FROM arena_snapshot a JOIN model m ON m.id = a.model_id
         WHERE a.category = 'text' AND m.openness = ?
           AND a.ts = (SELECT MAX(ts) FROM arena_snapshot WHERE category = 'text')
         ORDER BY a.elo DESC LIMIT 1`,
      )
      .get(openness) as FrontierSide | undefined) ?? null;

  const open = side('open');
  const closed = side('closed');

  const trend = (
    db
      .prepare(
        `SELECT a.ts,
                MAX(CASE WHEN m.openness = 'open' THEN a.elo END) AS open_elo,
                MAX(CASE WHEN m.openness = 'closed' THEN a.elo END) AS closed_elo
         FROM arena_snapshot a JOIN model m ON m.id = a.model_id
         WHERE a.category = 'text' GROUP BY a.ts ORDER BY a.ts ASC`,
      )
      .all() as { ts: string; open_elo: number | null; closed_elo: number | null }[]
  ).map(
    (r): FrontierPoint => ({
      ...r,
      gap: r.open_elo !== null && r.closed_elo !== null ? r.open_elo - r.closed_elo : null,
    }),
  );

  return {
    open,
    closed,
    gap: open && closed ? open.elo - closed.elo : null,
    trend,
  };
}

/* --------------------------------- search -------------------------------- */

/**
 * Ranked entity search for command-line autocomplete: prefix > word-boundary
 * substring > subsequence, weighted ticker > name > id-part > alias, with a
 * short-candidate tie-break. Candidates are cached for 30s — ~3k strings
 * score in well under a millisecond, the cache just avoids re-reading the
 * model/alias tables on every keystroke.
 */
interface SearchCandidate {
  text: string;
  via: SearchResult['via'];
  id: string;
}

const SEARCH_CACHE_TTL_MS = 30_000;
let searchCache: { builtAt: number; candidates: SearchCandidate[] } | null = null;

function searchCandidates(db: Database.Database): SearchCandidate[] {
  if (searchCache && Date.now() - searchCache.builtAt < SEARCH_CACHE_TTL_MS) {
    return searchCache.candidates;
  }
  const candidates: SearchCandidate[] = [];
  for (const m of db.prepare(`SELECT id, ticker, name FROM model`).all() as {
    id: string;
    ticker: string | null;
    name: string;
  }[]) {
    if (m.ticker !== null) candidates.push({ text: m.ticker.toLowerCase(), via: 'ticker', id: m.id });
    candidates.push({ text: m.name.toLowerCase(), via: 'name', id: m.id });
    const namePart = m.id.split('/').pop();
    if (namePart) candidates.push({ text: namePart, via: 'id', id: m.id });
  }
  for (const a of db.prepare(`SELECT alias, model_id FROM entity_alias`).all() as {
    alias: string;
    model_id: string;
  }[]) {
    candidates.push({ text: a.alias.toLowerCase(), via: 'alias', id: a.model_id });
  }
  searchCache = { builtAt: Date.now(), candidates };
  return candidates;
}

function isSubsequence(q: string, t: string): boolean {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

const VIA_WEIGHT: Record<SearchResult['via'], number> = { ticker: 15, name: 10, id: 8, alias: 5 };

function search(db: Database.Database, rawQuery: string): SearchResult[] {
  const q = rawQuery.trim().toLowerCase();
  if (q === '') return [];
  const best = new Map<string, { score: number; via: SearchResult['via'] }>();

  for (const cand of searchCandidates(db)) {
    let base: number;
    if (cand.text === q) base = 100;
    else if (cand.text.startsWith(q)) base = 80;
    else if (cand.text.includes(`-${q}`) || cand.text.includes(` ${q}`) || cand.text.includes(`/${q}`)) base = 60;
    else if (isSubsequence(q, cand.text)) base = 30;
    else continue;
    // Shorter candidates rank higher within a tier; via breaks field ties.
    const score = base + VIA_WEIGHT[cand.via] - Math.min(cand.text.length * 0.2, 10);
    const current = best.get(cand.id);
    if (!current || score > current.score) best.set(cand.id, { score, via: cand.via });
  }

  const results: SearchResult[] = [];
  for (const [id, { score, via }] of best) {
    const m = db.prepare(`SELECT id, ticker, name FROM model WHERE id = ?`).get(id) as {
      id: string;
      ticker: string | null;
      name: string;
    };
    results.push({ ...m, via, score: Math.round(score * 10) / 10 });
  }
  return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 10);
}