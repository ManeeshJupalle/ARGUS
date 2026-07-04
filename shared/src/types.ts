/**
 * ARGUS unified entity model — mirrors ARGUS_ARCHITECTURE.md §5 exactly.
 *
 * Field names match the SQL columns (snake_case) so rows map 1:1 onto these
 * types. Columns stored as JSON TEXT in SQLite (`modalities`, `sources`,
 * `model_ids`) are represented here in their parsed form; the DB layer is
 * responsible for JSON.parse/stringify at the boundary.
 */

/** The open-vs-closed axis, first-class. */
export type Openness = 'open' | 'closed';

/** A Model is a security. Everything else is market data attached to it. */
export interface Model {
  /** Canonical slug, e.g. "anthropic/claude-fable-5". */
  id: string;
  /** Short display code, e.g. "FABLE5". Generated in PHASE-2; null until then. */
  ticker: string | null;
  name: string;
  /** "anthropic", "openai", "meta-llama", ... */
  author_org: string;
  /** SPDX-ish or "proprietary". */
  license: string | null;
  openness: Openness;
  context_len: number | null;
  modalities: string[];
  released_at: string | null;
  /** Which upstreams know this entity, mapped to their native IDs. */
  sources: Record<string, string>;
}

/** From OpenRouter, every poll. */
export interface PriceSnapshot {
  model_id: string;
  ts: string;
  prompt_usd_per_mtok: number;
  completion_usd_per_mtok: number;
  provider_count: number | null;
  weekly_tokens_rank: number | null;
}

/** From LMArena, daily. */
export interface ArenaSnapshot {
  model_id: string;
  ts: string;
  /** "text" | "code" | "vision" | ... (open set upstream). */
  category: string;
  elo: number;
  rank: number;
  ci: number | null;
  votes: number | null;
}

/** From HuggingFace Hub, hourly (open models only). */
export interface HubSnapshot {
  model_id: string;
  ts: string;
  downloads: number;
  likes: number;
  trending_rank: number | null;
}

/** Slower-moving published evals (AA intelligence index etc.). */
export interface BenchScore {
  model_id: string;
  benchmark: string;
  score: number;
  as_of: string;
  source: string;
}

export interface NewsItem {
  id: string;
  ts: string;
  source: string;
  title: string;
  url: string;
  summary: string | null;
  salience: number | null;
  model_ids: string[];
  org: string | null;
}

/**
 * The hard problem: "claude-fable-5" vs "anthropic/claude-fable-5" vs
 * "Claude Fable 5" across upstreams; resolver table.
 */
export interface EntityAlias {
  alias: string;
  model_id: string;
}

/** Per-source poller health (§6), surfaced at GET /api/status. */
export interface SourceStatus {
  source: string;
  last_success: string | null;
  last_error: string | null;
  consecutive_failures: number;
  /** PHASE-5: computed server-side by the envelope stale rule (3x cadence). */
  stale?: boolean;
}

/* ------------------------------------------------------------------------ *
 * PHASE-4: read API response types (§6). The web app imports these in
 * Phase 5. Data fields stay snake_case/DB-aligned like everything above;
 * envelope meta (`asOf`, `stale`) follows the §6 contract verbatim.
 * ------------------------------------------------------------------------ */

/**
 * Every read endpoint responds with this envelope. `stale` is true when a
 * source the payload depends on is unhealthy (never succeeded, currently
 * failing, or last success older than 3x its poll cadence).
 */
export interface Envelope<T> {
  data: T;
  asOf: string;
  stale?: boolean;
}

/** One row of the market table (GET /api/models). */
export interface MarketRow {
  id: string;
  ticker: string | null;
  name: string;
  author_org: string;
  openness: Openness;
  license: string | null;
  context_len: number | null;
  released_at: string | null;
  /** Latest price snapshot; null for models OpenRouter doesn't serve. */
  prompt_usd_per_mtok: number | null;
  completion_usd_per_mtok: number | null;
  /** Latest text-category arena standing. */
  elo: number | null;
  arena_rank: number | null;
  /** Latest Artificial Analysis intelligence index (bench_score). */
  intelligence_index: number | null;
  /** Latest HF Hub downloads (open models). */
  downloads: number | null;
}

/** A model's latest standing in one arena category. */
export interface ArenaStanding {
  category: string;
  ts: string;
  elo: number;
  rank: number;
  ci: number | null;
  votes: number | null;
}

/** GET /api/models/:id — the DES payload. */
export interface ModelDetail {
  model: Model;
  aliases: string[];
  /** Latest price point; null if OpenRouter doesn't serve this model. */
  pricing: PricePoint | null;
  arena: ArenaStanding[];
  /** Latest score per (benchmark, source). */
  bench: BenchScore[];
  /** Latest hub snapshot; null for closed/unlisted models. */
  hub: { ts: string; downloads: number; likes: number; trending_rank: number | null } | null;
  /** Most recent news items mentioning this model. */
  news: NewsItem[];
}

export interface PricePoint {
  ts: string;
  prompt_usd_per_mtok: number;
  completion_usd_per_mtok: number;
}

export interface ArenaPoint {
  ts: string;
  elo: number;
  rank: number;
  ci: number | null;
  votes: number | null;
}

/** GET /api/models/:id/arena */
export interface ArenaSeries {
  category: string;
  points: ArenaPoint[];
}

export interface LeaderboardRow {
  rank: number;
  id: string;
  ticker: string | null;
  name: string;
  openness: Openness;
  elo: number;
  ci: number | null;
  votes: number | null;
  /** vs the closest board ≥7 days older; null when no such board exists. */
  elo_delta_7d: number | null;
  /** prior_rank - rank: positive = climbed. */
  rank_delta_7d: number | null;
}

/** GET /api/arena/leaderboard */
export interface Leaderboard {
  category: string;
  /** Publish date of the board shown; null when the category has no data. */
  board_date: string | null;
  /** Board the 7d deltas compare against. */
  prior_date: string | null;
  rows: LeaderboardRow[];
}

export interface BenchCompareModel {
  id: string;
  ticker: string | null;
  name: string;
  openness: Openness;
}

/** One matrix row; `values` aligns with BenchCompare.models order. */
export interface BenchCompareRow {
  key: string;
  source: string;
  values: (number | null)[];
}

/** GET /api/bench/compare */
export interface BenchCompare {
  models: BenchCompareModel[];
  rows: BenchCompareRow[];
}

/** GET /api/search */
export interface SearchResult {
  id: string;
  ticker: string | null;
  name: string;
  /** Which field matched. */
  via: 'ticker' | 'name' | 'id' | 'alias';
  score: number;
}

export interface PriceMover {
  id: string;
  ticker: string | null;
  name: string;
  prompt_usd_per_mtok: number;
  delta_pct_24h: number | null;
  delta_pct_7d: number | null;
}

export interface ArenaMover {
  id: string;
  ticker: string | null;
  name: string;
  rank: number;
  elo: number;
  rank_delta_7d: number;
  elo_delta_7d: number;
}

export interface DownloadSpike {
  id: string;
  ticker: string | null;
  name: string;
  downloads: number;
  delta_7d: number;
  delta_pct_7d: number;
}

export interface FrontierSide {
  id: string;
  ticker: string | null;
  elo: number;
}

export interface FrontierPoint {
  ts: string;
  open_elo: number | null;
  closed_elo: number | null;
  /** open_elo - closed_elo; null when either side is missing. */
  gap: number | null;
}

export interface Frontier {
  open: FrontierSide | null;
  closed: FrontierSide | null;
  gap: number | null;
  trend: FrontierPoint[];
}

/** GET /api/overview — the TOP payload. */
export interface Overview {
  stats: {
    models: number;
    open: number;
    closed: number;
    sources_total: number;
    sources_healthy: number;
  };
  price_movers: PriceMover[];
  arena_movers: ArenaMover[];
  download_spikes: DownloadSpike[];
  newest: { id: string; ticker: string | null; name: string; openness: Openness; released_at: string }[];
  news: NewsItem[];
  frontier: Frontier;
}

/* ------------------------------------------------------------------------ *
 * PHASE-4: SSE events (GET /api/stream). Emitted after each poll cycle with
 * just-changed ids; clients refetch the endpoints they care about.
 * ------------------------------------------------------------------------ */

export type SseEvent =
  | {
      type: 'snapshot';
      source: string;
      /** Which market-data facet changed. */
      fields: ('price' | 'arena' | 'downloads')[];
      model_ids: string[];
      ts: string;
    }
  | {
      type: 'news';
      /** news_item ids just inserted. */
      ids: string[];
      /** Union of models the new items mention. */
      model_ids: string[];
      ts: string;
    }
  | {
      type: 'status';
      source: string;
      ok: boolean;
      consecutive_failures: number;
      ts: string;
    };
