-- ARGUS database schema.
-- Implements the unified entity model from ARGUS_ARCHITECTURE.md §5,
-- plus source_status (§6). Idempotent: safe to execute on every boot.

-- A Model is a security. Everything else is market data attached to it.
CREATE TABLE IF NOT EXISTS model (
  id           TEXT PRIMARY KEY,            -- canonical slug, e.g. "anthropic/claude-fable-5"
  ticker       TEXT UNIQUE,                 -- short display code, e.g. "FABLE5" (generated in PHASE-2, editable map)
  name         TEXT NOT NULL,
  author_org   TEXT NOT NULL,               -- "anthropic", "openai", "meta-llama", ...
  license      TEXT,                        -- SPDX-ish or "proprietary"
  openness     TEXT NOT NULL CHECK (openness IN ('open', 'closed')),
  context_len  INTEGER,
  modalities   TEXT NOT NULL DEFAULT '[]',  -- JSON array
  released_at  TEXT,
  sources      TEXT NOT NULL DEFAULT '{}'   -- JSON: which upstreams know this entity + their native IDs
);

-- From OpenRouter, every poll.
CREATE TABLE IF NOT EXISTS price_snapshot (
  model_id                 TEXT NOT NULL REFERENCES model(id),
  ts                       TEXT NOT NULL,
  prompt_usd_per_mtok      REAL NOT NULL,
  completion_usd_per_mtok  REAL NOT NULL,
  provider_count           INTEGER,
  weekly_tokens_rank       INTEGER,
  PRIMARY KEY (model_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_price_snapshot_ts ON price_snapshot(ts);

-- From LMArena, daily.
CREATE TABLE IF NOT EXISTS arena_snapshot (
  model_id  TEXT NOT NULL REFERENCES model(id),
  ts        TEXT NOT NULL,
  category  TEXT NOT NULL,                  -- text, code, vision, ...
  elo       REAL NOT NULL,
  rank      INTEGER NOT NULL,
  ci        REAL,
  votes     INTEGER,
  PRIMARY KEY (model_id, category, ts)
);
CREATE INDEX IF NOT EXISTS idx_arena_snapshot_ts ON arena_snapshot(ts);
-- PHASE-4 addition: leaderboard/series queries are category-first ("latest
-- text board", "frontier gap per date") and the PK (model_id, category, ts)
-- can't serve them; at 18k+ rows those were full scans per request.
CREATE INDEX IF NOT EXISTS idx_arena_snapshot_category_ts ON arena_snapshot(category, ts);

-- From HF Hub, hourly (open models only).
CREATE TABLE IF NOT EXISTS hub_snapshot (
  model_id       TEXT NOT NULL REFERENCES model(id),
  ts             TEXT NOT NULL,
  downloads      INTEGER NOT NULL,
  likes          INTEGER NOT NULL,
  trending_rank  INTEGER,
  PRIMARY KEY (model_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_hub_snapshot_ts ON hub_snapshot(ts);

-- Slower-moving published evals (AA intelligence index etc.).
CREATE TABLE IF NOT EXISTS bench_score (
  model_id   TEXT NOT NULL REFERENCES model(id),
  benchmark  TEXT NOT NULL,
  score      REAL NOT NULL,
  as_of      TEXT NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (model_id, benchmark, source, as_of)
);

CREATE TABLE IF NOT EXISTS news_item (
  id        TEXT PRIMARY KEY,
  ts        TEXT NOT NULL,
  source    TEXT NOT NULL,
  title     TEXT NOT NULL,
  url       TEXT NOT NULL,
  summary   TEXT,
  salience  REAL,
  model_ids TEXT NOT NULL DEFAULT '[]',     -- JSON array of model.id
  org       TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_item_ts ON news_item(ts);

-- The hard problem: "claude-fable-5" vs "anthropic/claude-fable-5" vs
-- "Claude Fable 5" across upstreams; resolver table (PHASE-2 populates it).
CREATE TABLE IF NOT EXISTS entity_alias (
  alias     TEXT PRIMARY KEY,
  model_id  TEXT NOT NULL REFERENCES model(id)
);

-- Rows the entity resolver could not safely attach to a model (§5: quarantine
-- unresolvable rows rather than corrupting the entity table), plus rows a
-- poller skipped as unparseable. Re-polls update in place (UNIQUE source+raw),
-- so repeated cycles never grow this table for the same offender.
CREATE TABLE IF NOT EXISTS quarantine (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  source  TEXT NOT NULL,
  raw     TEXT NOT NULL,
  reason  TEXT NOT NULL,
  payload TEXT,                              -- JSON context, truncated
  ts      TEXT NOT NULL,
  UNIQUE (source, raw)
);

-- PHASE-6: single-user watchlist (§7 WATCH). The only user-writable table.
CREATE TABLE IF NOT EXISTS watchlist (
  model_id  TEXT PRIMARY KEY REFERENCES model(id),
  added_at  TEXT NOT NULL
);

-- Per-source poller health (§6); surfaced at GET /api/status.
CREATE TABLE IF NOT EXISTS source_status (
  source                TEXT PRIMARY KEY,
  last_success          TEXT,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0
);

-- PHASE-1 ONLY: demo table written by the heartbeat poller to prove the
-- scheduler loop end-to-end. Not part of the §5 entity model; real pollers
-- (PHASE-2+) write the snapshot tables above instead.
CREATE TABLE IF NOT EXISTS heartbeat (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts  TEXT NOT NULL
);
