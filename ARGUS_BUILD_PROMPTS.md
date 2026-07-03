# ARGUS — Sequential Claude Code Build Prompts

**How to use:** One phase per Claude Code session, in order. Paste the phase prompt plus `ARGUS_ARCHITECTURE.md` into context. Verify the acceptance gate yourself before requesting the next phase. Default reasoning effort: xhigh.

**Global constraints (repeat in every session):**
- Do NOT build features from any later phase. If a later-phase feature seems necessary now, stub the interface and add a `// PHASE-N` comment instead.
- Every external API boundary is parsed with zod. Unparseable data is logged and skipped, never crashes a poller.
- No paid APIs, no auth systems, no inference calls to models. Local-first.
- All new external payload shapes must be derived from a real fetched sample, saved to `server/fixtures/`, never assumed.
- TypeScript strict mode everywhere. No `any` at module boundaries.

---

## PHASE 1 — Scaffold, Database, Scheduler Skeleton

**Context:** Greenfield. Read `ARGUS_ARCHITECTURE.md` in full before writing anything, especially §2 (stack), §5 (entity model), §6 (backend design), §9 (structure).

**Build:**
1. npm-workspaces monorepo per §9: `shared/`, `server/`, `web/` (web is a bare Vite React TS scaffold this phase — no terminal UI yet).
2. `shared/src/types.ts`: TypeScript types mirroring the §5 entity model exactly.
3. `server/src/db/schema.sql` implementing §5 tables plus `source_status`, and `db.ts` (better-sqlite3, WAL mode, migration-on-boot from schema file).
4. Scheduler per §6: pollers register `{name, cadence, run()}`; jittered start; per-source exponential backoff on failure; every run updates `source_status`. Include one `heartbeat` demo poller (writes a timestamp) to prove the loop.
5. Hono server: `GET /api/health`, `GET /api/status` (reads `source_status`). Vite dev proxy `/api → server`.
6. `--reset` CLI flag: drops and rebuilds DB, prints confirmation.
7. Root scripts: `npm run dev` (server + web concurrently), `npm run reset`.

**Acceptance gate (I verify):** fresh clone → `npm install` → `npm run dev` works; `/api/health` and `/api/status` respond; heartbeat rows accumulate; `npm run reset` wipes them; schema matches §5.

**Do not:** build any real poller, any API route beyond the two above, any UI, SSE, or seed mode.

---

## PHASE 2 — OpenRouter Ingestion + Entity Resolver (Hard Component 1)

**Context:** Phase 1 verified. This phase creates the market backbone.

**Build:**
1. **First step, before code:** fetch `https://openrouter.ai/api/v1/models` live, save the real response to `server/fixtures/openrouter-models.json`, and derive the zod schema from what you actually observe (pricing values are USD-per-token *strings*; verify field names against the payload, not memory).
2. OpenRouter poller (15-min cadence): parse → resolve → write `model` upserts + `price_snapshot` rows in one transaction. Capture: pricing, context length, modalities, author org, created date, license/openness inference, provider count. If the payload exposes an intelligence-index or popularity signal, capture into `bench_score` / snapshot fields.
3. **Entity resolver** (`server/src/resolver/entity-resolver.ts`): canonical ID normalization (lowercase, org/name form), alias table lookups, deterministic rules (strip version suffixes like `:free`, date stamps), fuzzy last-resort with confidence threshold, and a `quarantine` table for sub-threshold rows. Design the API so Phase 3 pollers reuse it unchanged.
4. **Ticker generator:** short display codes per §5 (`anthropic/claude-fable-5` → `FABLE5`), collision-safe, stored on `model`, overridable via a checked-in `tickers.json` map.
5. **Vitest suite for the resolver** (this is one of the two designated hard components): exact match, alias hit, rule-based normalization, fuzzy accept, fuzzy reject → quarantine, idempotent re-runs. Use fixture data.
6. Extend `/api/status` so OpenRouter source health is visible.

**Acceptance gate:** after one poll cycle the `model` table holds several hundred rows with sane tickers; a second cycle adds `price_snapshot` rows without duplicating models; resolver tests pass; malformed fixture variants are skipped with a log line, not a crash.

**Do not:** build other pollers, REST endpoints beyond status/health, SSE, seed mode, or any UI.

---

## PHASE 3 — Secondary Sources: Arena, HF Hub, News

**Context:** Phases 1–2 verified. Resolver exists — reuse it; do not fork resolution logic per source.

**Build:**
1. **LMArena poller (daily).** First step: live-verify access to the official HF dataset `lmarena-ai/leaderboard-dataset` via the HF datasets-server rows API (`text_style_control` subset; `latest` split for current board, `full` for history). Save a real sample to fixtures. If the datasets-server route is unavailable or awkward, fall back to the mirror `https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text` — decide based on what you observe, document the choice in code comments. Backfill historical snapshots into `arena_snapshot` where the source provides history (this powers ARENA charts — it matters).
2. **HF Hub poller (hourly):** `https://huggingface.co/api/models` sorted by downloads, capped to a sane top-N (e.g. 500) plus any model already in our entity table; write `hub_snapshot` (downloads, likes, trending) and enrich `model.openness`/license.
3. **News pollers:** (a) HN Algolia `search_by_date` with an AI/model query set, salience = points; (b) lab RSS feeds — verify each feed URL live from the §4 org list, skip dead ones silently with a status note; (c) arXiv API (cs.CL/cs.LG/cs.AI, respect 1-req/3s politeness). All write `news_item`; run model-mention extraction against the entity table + aliases to populate `model_ids`.
4. **Seed mode:** `npm run seed` loads all fixtures into a fresh DB so the app is fully populated offline.

**Acceptance gate:** `arena_snapshot` contains current + historical rows joined to canonical models; hub snapshots accrue for open models; `news_item` fills from ≥2 working news sources with model linkage on obvious items; `npm run seed` on a fresh DB yields a populated dataset; every source's health visible in `/api/status`; no crash when any single source is unreachable (test by blocking one).

**Do not:** build GitHub stars poller (backlog), REST read API, SSE, or UI.

---

## PHASE 4 — Read API + SSE

**Context:** Data layer complete. This phase exposes it.

**Build:**
1. All REST endpoints from §6 exactly as listed (`/api/models`, `/api/models/:id`, `.../prices`, `.../arena`, `/api/arena/leaderboard`, `/api/bench/compare`, `/api/news`, `/api/overview`, `/api/search`). Query params validated with zod; consistent envelope `{data, asOf, stale?}` where `stale` reflects source health.
2. `/api/overview` (the TOP payload) computes: top price movers (Δ over 24h/7d), biggest arena rank moves, download velocity spikes, newest models, latest news, open-vs-closed frontier gap (best open ELO minus best closed ELO, text category, with trend).
3. `/api/search?q=`: ranked entity search over name/ticker/aliases (prefix > subsequence), built for command-line autocomplete latency (<10ms typical).
4. SSE at `/api/stream` per §6: after each poll cycle, emit compact change events (`snapshot`, `news`, `status`) with just-changed model IDs and fields. Heartbeat comment every 25s to keep connections alive.
5. Shared response types in `shared/src/types.ts`; the web app will import these in Phase 5.

**Acceptance gate:** every endpoint returns correct, zod-validated shapes against seeded data (spot-check with curl); `/api/overview` numbers are plausible and change after a poll; SSE stream visibly emits events when a poll cycle completes; search returns sensible ranked results for partial tickers ("fab" → FABLE5).

**Do not:** build any React UI, panels, command parser, or charts.

---

## PHASE 5 — Terminal Shell: Layout, Command Line (Hard Component 2), TOP Screen

**Context:** API complete. This phase is where Argus starts looking like Argus. Follow §8 design tokens *exactly* — this is Bloomberg's visual language, not a generic dark theme. True black background, amber data text, blue function codes, dense uppercase monospace, tiny type, no border radius, no shadows, no gradients.

**Build:**
1. `web/src/styles/tokens.css` with the §8 variables verbatim; single monospace family (JetBrains Mono via local install or system fallback stack), tabular numerals enabled.
2. **Shell layout:** fixed command line at top; CSS-grid panel area (default: one full-size panel; grid presets 1/2/4 via `LAYOUT` stub — stub only); fixed status bar at bottom showing source health dots from `/api/status`, live clock, SSE connection state.
3. **Command line — the second designated hard component:** tokenizer → grammar from §7 (`[ENTITY] FUNCTION [ARGS]`) → entity resolution via `/api/search` with debounce → dispatch. Ghost-text inline autocomplete, `Tab` accept, `↑/↓` history, `Esc` clear, `/` or `Ctrl+K` focus-from-anywhere, Enter renders a transient green `<GO>` chip. Unknown function/entity errors render inline in the command line in red, Bloomberg-style, without a modal. **Vitest suite:** tokenization, valid dispatches for every v1 function signature, arg validation failures, entity-ambiguity behavior.
4. **TOP panel** (default screen, the demo money shot): market stat header (model count, open/closed split, frontier gap with trend arrow), top movers table (price + arena), newest models, latest news column. Live: subscribe to SSE, flash changed cells with `--flash` (400ms fade), respect `prefers-reduced-motion`.
5. Function registry in `shared/src/commands.ts`: every §7 function declared with name, arg schema, panel component mapping — later phases only add entries, never restructure.
6. Min-width gate: below ~1100px render a centered "ARGUS requires a desktop viewport" notice in-theme.

**Acceptance gate:** `npm run dev` on seeded data opens straight into a dense, Bloomberg-looking TOP screen; typing `TOP` re-renders it; `HELP` shows a stub list; unknown commands error inline; SSE ticks visibly flash cells; command parser tests pass; zero layout shift while data streams in.

**Do not:** build DES/PX/ARENA/BENCH/NEWS/WATCH panels (stubs routing to "FUNCTION NOT YET AVAILABLE" in-theme are fine), multi-panel focus switching, or saved layouts.

---

## PHASE 6 — Core Function Panels

**Context:** Shell + parser verified. This phase fills the terminal.

**Build (all panels consume the function registry + typed API client; all follow §8 tokens):**
1. **DES** — spec sheet: identity block (name, ticker, org, openness badge, license, release date), pricing block (current $/MTok prompt+completion, provider count), capability block (context, modalities), latest arena standings summary, mini news list for this model. Blue function codes at the bottom (`PX  ARENA  BENCH  NEWS`) that are clickable AND typeable.
2. **PX** — price history chart via lightweight-charts (timebox: if React integration fights for >1 session-hour, fall back to recharts and note it): prompt + completion series, range args `30D/90D/MAX`, crosshair readout, delta header (`▲/▼ x% vs 30D`). Handle sparse early history gracefully.
3. **ARENA** — no entity: current leaderboard table for a category (rank, ticker, ELO, CI, votes, 7d Δ, openness badge), category arg (`TEXT/CODE/VISION`). With entity: that model's ELO/rank history chart.
4. **BENCH** — comparison matrix for 2–5 entities: rows = benchmarks/metrics available in `bench_score` + headline arena ELO + price + context; best-in-row highlighted amber. Missing cells render `—`, never fake data.
5. **NEWS** — dense feed (time, source tag, salience, headline, linked model tickers as blue codes); entity arg filters; new items slide in via SSE.
6. **MKT** — full market table with `OPEN/CLOSED` filter arg, sortable columns (price, context, weekly rank, ELO), 200+ rows virtualized.
7. **MOV** — top movers detail (price cuts, rank jumps, download spikes over 24h/7d).
8. **WATCH** — `WATCH ADD/RM <ticker>`, `WATCH` shows a compact live quote board of watched models (price, ELO, Δs, flashing on ticks). Persist server-side in a `watchlist` table (single-user).
9. Multi-panel: `LAYOUT 2/4` grid presets, `F1–F9` panel focus, commands execute into the focused panel.

**Acceptance gate:** every §7 v1 function executes end-to-end from the command line on seeded + live data; PX and ARENA render real historical curves; BENCH with 3 models is legible and honest about gaps; WATCH persists across reload; 4-panel layout with TOP + WATCH + NEWS + PX all live simultaneously stays smooth (no jank while SSE ticks).

**Do not:** build alerting, export, themes, auth, or README/demo assets.

---

## PHASE 7 — Polish, Tests-Gap Pass, README, Fresh-Clone Hardening

**Context:** Feature-complete. This phase makes it shippable and recruiter-ready.

**Build:**
1. **HELP** panel: full function reference generated from the command registry (grammar, args, examples), plus keyboard map. This doubles as documentation.
2. **STAT** panel: per-source health, last poll times, row counts, quarantine count — the "plumbing on display" panel that engineers love in demos.
3. Error/empty states pass: every panel handles no-data, stale-source, and API-down states in-theme (amber `STALE` badges, never blank white).
4. Test-gap pass on the two hard components only (resolver, parser): add cases for any bug found during Phases 5–6; do not chase coverage elsewhere.
5. `docker-compose.yml` (server + web, one command) verified.
6. **README.md as recruiter artifact:** hero demo GIF placeholder at top, the wedge paragraph (websites-you-browse vs terminal-you-operate, per §1), architecture diagram, function reference table, honest limitations section (coverage bias toward API-served models; daily arena cadence; single-user local-first — house style: document the misses with root causes), quickstart (`git clone → npm i → npm run seed → npm run dev`), stack list.
7. Fresh-clone smoke script (`npm run smoke`): clean checkout → install → seed → boot → curl health + overview → report PASS/FAIL.

**Acceptance gate (final):** smoke script passes on an actual fresh clone; seeded first-run reaches a populated TOP screen in under ~30 seconds from `npm i` finishing; README reads as a portfolio piece; `HELP` accurately reflects every implemented function; nothing in the app dead-ends without an in-theme message.

**Post-build checklist (mine, not Claude Code's):** record demo GIF (suggested take: cold boot → TOP live → `FABLE5 DES` → `PX 90D` → `ARENA CODE` → 4-panel layout), GitHub push, pin repo.
