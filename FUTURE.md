# FUTURE — backlog, deliberately not built

Features that came up during the build and were parked to protect scope.
Nothing here blocks the v1 acceptance gates.

- **GitHub stars poller** (§4, lowest priority) — repo momentum for open
  models; backlogged since Phase 3.
- **SSE `Last-Event-ID` resume** — clients currently resync-on-reconnect
  instead of replaying missed events; fine at this cadence, wasteful at
  higher ones.
- **Arena sub-category backfill** — coding/math/etc. history accrues daily
  from install; if the upstream dataset ever exposes per-category history
  splits, backfill them like text.
- **Production build path** — `vite build` + static serving from the Hono
  server (single container, no dev servers). Compose currently ships dev
  servers, which is fine for a local demo.
- **Watchlist import/export** — plain-text ticker list in/out.
- **Alerting** — price-cut / rank-move thresholds firing desktop
  notifications; explicit v1 non-goal.
- **Themes** — the amber Bloomberg language is contractual for v1; a green
  IBM-3278 variant is one tokens.css swap away.
- **Multi-user / auth** — explicit non-goal (§1); local-first single user.
- **Mobile layout** — explicit non-goal (§1); min-width gate stays.
