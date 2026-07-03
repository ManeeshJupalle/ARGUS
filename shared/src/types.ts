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
}
