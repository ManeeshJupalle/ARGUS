# ARGUS — Architecture Document

**A Bloomberg-style terminal for the AI model ecosystem.**

> Argus: the hundred-eyed watchman of Greek myth. Sees everything at once, never fully sleeps.

---

## 1. Positioning & Wedge

**One-liner:** Argus is a Bloomberg terminal for AI models — real-time pricing, rankings, benchmarks, and news for every notable LLM (open and closed), operated through a keyboard-first command line instead of browsed like a website.

**The wedge (README paragraph material):** The data Argus displays already exists scattered across Artificial Analysis, LMArena, HuggingFace, OpenRouter, and a dozen lab blogs — but all of it is packaged as *websites you browse*. Argus packages it as a *terminal you operate*: mnemonic commands, multi-panel layouts, watchlists, historical charts, and a unified entity model, built for people who track the AI model market the way traders track equities. The incumbents are dashboards; Argus is a workstation.

**What Argus is NOT (v1 non-goals):**
- Not an inference playground. Argus never calls models; it tracks them.
- Not a benchmark runner. It aggregates published evals; it does not execute them.
- Not multi-user / no auth / no accounts. Local-first, single user, like CashPulse.
- No paid data sources. Every source is free-tier or public.
- No mobile layout in v1. This is a dense desktop workstation (min-width gate with a polite message below ~1100px).

**Portfolio framing:** fills the "data-intensive frontend + real-time aggregation backend" gap; domain signal for both AI orgs (ecosystem obsession) and quant firms (terminal paradigm fluency, market-data mental models: entities, ticks, snapshots, time series).

---

## 2. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Monorepo | npm workspaces: `/server`, `/web`, `/shared` | Simple, no extra tooling; `shared` holds TypeScript types + command registry used by both sides |
| Backend | Node 20+, TypeScript, **Hono** | Already proven in Synapse stack; tiny, fast, first-class SSE support |
| Storage | **better-sqlite3** | Local-first, synchronous, proven in prior projects; WAL mode |
| Validation | **zod** | Parse-don't-validate at every external API boundary |
| Frontend | **React 18 + Vite + TypeScript** | Known stack; Vite dev proxy to server |
| State | **zustand** | Light global store for panels, watchlist, command state |
| Charts | **lightweight-charts** (TradingView) | The genuinely Bloomberg-looking chart library: candlestick-grade time series, crosshair, dark-native. Fallback: recharts if integration fights back in Phase 6 |
| Fuzzy matching | **fzf-style matcher** (e.g. `fzf-for-js` or hand-rolled subsequence scorer) | Command line autocomplete |
| Styling | Plain CSS modules + CSS variables (design tokens) | No Tailwind: the terminal aesthetic is bespoke enough that utility classes add noise |
| Testing | **vitest** | Unit tests on the two hard components (normalizer, command parser) per house rule |
| Package/dist | GitHub repo; `docker-compose up` and `npm run dev` both work from fresh clone | Recruiter runs it in one command |

---

## 3. System Architecture

```
                      ┌──────────────────────────────────────────────┐
                      │                  SERVER (Hono)               │
                      │                                              │
  OpenRouter API ──┐  │  ┌──────────┐   ┌────────────┐   ┌────────┐  │
  HF Hub API ──────┤  │  │ Pollers  │──▶│ Normalizer │──▶│ SQLite │  │
  LMArena dataset ─┼──┼─▶│ (per-src │   │ (zod → uni-│   │ (WAL)  │  │
  arXiv API ───────┤  │  │ cadence) │   │ fied model)│   └───┬────┘  │
  HN Algolia ──────┤  │  └──────────┘   └────────────┘       │       │
  Lab RSS feeds ───┘  │        │                             │       │
                      │        ▼                             ▼       │
                      │  ┌──────────┐              ┌───────────────┐ │
                      │  │ Scheduler│              │ REST API + SSE│ │
                      │  └──────────┘              └───────┬───────┘ │
                      └────────────────────────────────────┼─────────┘
                                                           │
                                              ┌────────────▼────────────┐
                                              │        WEB (React)      │
                                              │  Command line ▸ Router  │
                                              │  Panel grid ▸ Functions │
                                              │  (TOP DES PX ARENA ...) │
                                              └─────────────────────────┘
```

**Key decisions:**
1. **The browser never talks to external APIs.** All polling happens server-side: protects rate limits, hides any optional keys, and centralizes normalization. The frontend consumes one clean internal API.
2. **Snapshot-based history.** Every poll writes immutable snapshot rows (price, rank, downloads at time T). Time series = SELECT over snapshots. This is what makes `PX` and `ARENA` charts possible and is the most Bloomberg-like architectural property.
3. **SSE, not WebSockets.** Data cadence is minutes-to-daily; SSE gives the live-terminal feel (ticks animating in) with a fraction of the complexity.
4. **Degrade gracefully per source.** Any single upstream failing marks that source stale (shown in the status bar, Bloomberg-style) but never takes down the terminal.

---

## 4. Data Sources (verified July 2026)

| Source | Endpoint | Data | Cadence | Auth | Notes |
|---|---|---|---|---|---|
| **OpenRouter Models API** | `GET https://openrouter.ai/api/v1/models` | ~400 models: pricing (USD/token, prompt+completion), context length, modalities, provider, author org, created date, popularity sorts, Artificial Analysis intelligence index (via `sort=intelligence-high-to-low`) | 15 min | None | The market backbone. Supports server-side filters (`author`, `family`, `provider`) and sorts (`pricing-low-to-high`, `top-weekly`, `newest`, `context-high-to-low`). Single-model lookup: `GET /api/v1/model/{slug}` |
| **LMArena leaderboard** | HF dataset `lmarena-ai/leaderboard-dataset` via HF datasets-server rows API | Official Arena ELO snapshots, historical: rating, rank, CI, votes, per category (text, code, vision...), `text_style_control` subset, `latest` + `full` splits | Daily | None | **Historical rank/ELO time series** — powers ARENA charts. Fallback mirror: `api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text` (free, no auth, daily JSON). Builder must verify exact datasets-server URL shape at build time |
| **HuggingFace Hub API** | `GET https://huggingface.co/api/models` | Open-weight models: downloads, likes, trending, tags, license, gated status | 1 hr | None (higher limits w/ optional token) | Open-source side of the market; download velocity = volume metric |
| **arXiv API** | `http://export.arxiv.org/api/query` | Papers (cs.CL, cs.LG, cs.AI), Atom XML | 1 hr | None | NEWS feed component; polite rate limit (1 req/3s) |
| **HN Algolia API** | `https://hn.algolia.com/api/v1/search_by_date?query=...` | AI/model news + community signal (points as salience) | 15 min | None | NEWS feed component |
| **Lab RSS/blogs** | OpenAI, Anthropic, Google DeepMind, Meta AI, Mistral, xAI, DeepSeek, Qwen feeds | Release announcements | 30 min | None | Builder verifies each feed URL at build time; any dead feed is skipped, not fatal |
| **GitHub API** | `GET /repos/{org}/{repo}` | Stars/momentum for open-source model repos | 6 hr | Optional token (60/hr unauth → 5000/hr) | Lowest priority; ship in Phase 3 only if time allows, else backlog |

**Grounding rule (house rule):** every Claude Code phase that touches a source must first fetch a real sample response and derive the zod schema from *observed* payloads, never from assumptions. Store one sample per source in `server/fixtures/` for tests.

---

## 5. Unified Entity Model

The core abstraction: a **Model** is a security. Everything else is market data attached to it.

```
model
  id            TEXT PK          -- canonical slug, e.g. "anthropic/claude-fable-5"
  ticker        TEXT UNIQUE      -- short display code, e.g. "FABLE5" (generated, editable map)
  name          TEXT
  author_org    TEXT             -- "anthropic", "openai", "meta-llama", ...
  license       TEXT             -- SPDX-ish or "proprietary"
  openness      TEXT             -- 'open' | 'closed'  (the open-vs-closed axis, first-class)
  context_len   INTEGER
  modalities    TEXT             -- JSON array
  released_at   TEXT
  sources       TEXT             -- JSON: which upstreams know this entity + their native IDs

price_snapshot                    -- from OpenRouter, every poll
  model_id, ts, prompt_usd_per_mtok, completion_usd_per_mtok, provider_count, weekly_tokens_rank

arena_snapshot                    -- from LMArena, daily
  model_id, ts, category, elo, rank, ci, votes

hub_snapshot                      -- from HF, hourly (open models only)
  model_id, ts, downloads, likes, trending_rank

bench_score                       -- slower-moving published evals (AA intelligence index etc.)
  model_id, benchmark, score, as_of, source

news_item
  id, ts, source, title, url, summary, salience, model_ids (JSON), org

entity_alias                      -- the hard problem: "claude-fable-5" vs "anthropic/claude-fable-5"
  alias TEXT PK, model_id FK      -- vs "Claude Fable 5" across upstreams; resolver table
```

**The entity resolver is one of the two designated hard components** (unit-tested): heterogeneous upstreams name the same model differently; the resolver canonicalizes via normalization rules + alias table + fuzzy fallback, and *quarantines* unresolvable rows rather than corrupting the entity table.

---

## 6. Backend Design

- **Scheduler:** simple in-process interval scheduler; each poller declares `{ name, cadence, run() }`. Jittered starts, per-source backoff on failure, `source_status` table (last_success, last_error, consecutive_failures) surfaced at `/api/status` → frontend status bar.
- **Pollers:** one module per upstream. Each: fetch → zod-parse → resolve entities → write snapshots in a single transaction. Idempotent; safe to re-run.
- **REST API (all JSON):**
  - `GET /api/models?filter=...&sort=...` — the market table
  - `GET /api/models/:id` — full entity (DES payload)
  - `GET /api/models/:id/prices?range=30d` — PX series
  - `GET /api/models/:id/arena?category=text&range=90d` — ARENA series
  - `GET /api/arena/leaderboard?category=text` — current board
  - `GET /api/bench/compare?ids=a,b,c` — BENCH matrix
  - `GET /api/news?limit=...&model=...` — NEWS feed
  - `GET /api/overview` — TOP payload (movers, frontier gap, latest news, stats)
  - `GET /api/status` — source health
  - `GET /api/search?q=` — entity search for command-line autocomplete
- **SSE:** `GET /api/stream` — server pushes `{type: 'snapshot'|'news'|'status', ...}` events after each poll cycle; frontend animates changed cells (the classic terminal "tick flash").
- **Seed/demo mode:** `npm run seed` loads bundled fixture snapshots so a fresh clone shows a fully-populated terminal instantly, before the first live poll completes. Critical for the demo GIF and recruiter first-run.
- **`--reset` flag** on the server binary: drops and rebuilds the DB (house pattern from Starling).

---

## 7. Command Grammar & Function Set

Bloomberg grammar, adapted: `[ENTITY] FUNCTION [ARGS] <GO>` (Enter = `<GO>`).

```
FABLE5 DES            → model description/spec sheet
FABLE5 PX 90D         → token price history chart
FABLE5 ARENA CODE     → arena ELO history, code category
BENCH FABLE5 GPT5 GEM3→ side-by-side benchmark matrix
ARENA TEXT            → current text leaderboard (no entity = board view)
TOP                   → market overview (default screen)
NEWS [entity]         → news feed, optionally filtered
WATCH ADD FABLE5      → watchlist management
MKT OPEN | MKT CLOSED → market table filtered open-source / closed
HELP                  → function reference
```

**v1 function set (12, done deeply):** `TOP`, `DES`, `PX`, `ARENA`, `BENCH`, `NEWS`, `WATCH`, `MKT`, `MOV` (top movers: price cuts, rank jumps, download spikes), `STAT` (source health), `HELP`, `LAYOUT` (save/load panel arrangements).

**The command parser is the second designated hard component** (unit-tested): tokenizer → entity resolution (fuzzy, via `/api/search`) → function dispatch → arg validation, with Bloomberg-style inline error messaging in the command line itself.

**Keyboard model:** `/` or `Ctrl+K` focuses command line from anywhere; `Tab` autocompletes; `↑/↓` command history; `F1-F9` jump to panel N; `Esc` clears. Mouse works but is never required.

---

## 8. Frontend Design — Terminal Aesthetic (design tokens)

The brief pins the visual direction: **Bloomberg, specifically** — not generic hacker-dark. Encode Bloomberg's actual language:

```css
--bg:           #000000;   /* true black, not near-black */
--panel-border: #333338;   /* hairline panel chrome */
--amber:        #FF9F0A;   /* primary data text — Bloomberg amber, headers/values */
--white:        #E8E8E8;   /* secondary text */
--label:        #7A7A85;   /* dim uppercase field labels */
--up:           #00C853;   /* green ticks */
--down:         #FF3B30;   /* red ticks */
--func:         #4FA8FF;   /* blue = interactive/clickable function codes */
--accent-bar:   #FF9F0A;   /* active panel indicator */
--flash:        rgba(255,159,10,.25);  /* cell change flash, 400ms fade */
```

- **Type:** single monospace family for ALL data (`IBM Plex Mono` or `Berkeley Mono`-alike via `JetBrains Mono`), tiny sizes (11–13px), UPPERCASE labels, tabular numerals. No display font — density *is* the aesthetic.
- **Layout:** CSS grid of panels; command line fixed at top (Bloomberg puts it top-left); status bar fixed at bottom (source health, clock, connection dot). Panels have title bars: `FABLE5 US·AI  DES ▸ MODEL DESCRIPTION` style.
- **Signature element:** the command line itself — amber caret, ghost-text autocomplete, and the `<GO>` key rendering as a literal green `<GO>` chip when Enter is pressed.
- **Motion:** exactly two: cell flash on tick, and panel content swap (no fade — instant, like a real terminal). Respect `prefers-reduced-motion`.
- **Numbers:** prices as `$X.XX/MTOK`, deltas always signed and colored, ELO deltas as `▲12` / `▼8`.

---

## 9. Project Structure

```
argus/
├── package.json            # npm workspaces
├── docker-compose.yml
├── README.md               # recruiter artifact: hero GIF, wedge paragraph, quickstart
├── shared/
│   └── src/{types.ts, commands.ts, tickers.ts}
├── server/
│   ├── src/
│   │   ├── index.ts        # Hono app + scheduler boot; --reset flag
│   │   ├── db/{schema.sql, db.ts}
│   │   ├── pollers/{openrouter.ts, arena.ts, hub.ts, news/*.ts}
│   │   ├── resolver/entity-resolver.ts        # HARD COMPONENT 1 (tested)
│   │   ├── api/{routes.ts, sse.ts}
│   │   └── seed.ts
│   └── fixtures/           # real sampled upstream payloads
└── web/
    └── src/
        ├── command/{parser.ts, ...}           # HARD COMPONENT 2 (tested)
        ├── panels/{Top.tsx, Des.tsx, Px.tsx, Arena.tsx, Bench.tsx, News.tsx, ...}
        ├── layout/{Grid.tsx, StatusBar.tsx, CommandLine.tsx}
        ├── store/
        └── styles/tokens.css
```

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LMArena dataset access shape differs from assumption | Phase 3 begins with live verification; fallback mirror API documented above; worst case, daily GitHub-Actions-fetched JSON committed as data |
| Entity name chaos across sources | Resolver + alias table + quarantine, unit-tested; imperfect matches degrade to per-source display, never corrupt |
| OpenRouter coverage bias (only API-served models) | Acceptable v1 scope: "the tradeable market." HF fills open-weight long tail |
| Chart lib fight (lightweight-charts + React) | Timebox in Phase 6; recharts fallback pre-approved |
| Scope creep (alerting, auth, inference) | Non-goals list is contractual; every phase prompt repeats it |
