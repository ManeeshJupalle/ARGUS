import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { registerApiRoutes } from './api/routes';
import { SseHub } from './api/sse';
import { DB_PATH, openDb, resetDb } from './db/db';
import { createArenaPoller } from './pollers/arena';
import { createHeartbeatPoller } from './pollers/heartbeat';
import { createHubPoller } from './pollers/hub';
import { createArxivPoller } from './pollers/news/arxiv';
import { createHnPoller } from './pollers/news/hn';
import { createRssPoller, LAB_FEEDS } from './pollers/news/rss';
import { createOpenRouterPoller } from './pollers/openrouter';
import { EntityResolver } from './resolver/entity-resolver';
import { Scheduler } from './scheduler/scheduler';

const db = openDb();

if (process.argv.includes('--reset')) {
  const dropped = resetDb(db);
  console.log(`[argus] database reset: ${DB_PATH}`);
  console.log(`[argus] dropped ${dropped.length} tables (${dropped.join(', ')})`);
  console.log('[argus] schema rebuilt from schema.sql — all data wiped');
  db.close();
  process.exit(0);
}

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));
// /api/status is registered by registerApiRoutes (enriched with `stale`).

const resolver = new EntityResolver(db);
const scheduler = new Scheduler(db);
const pollers = [
  createHeartbeatPoller(db),
  createOpenRouterPoller(db, resolver),
  createArenaPoller(db, resolver),
  createHubPoller(db, resolver),
  createHnPoller(db),
  createArxivPoller(db),
  ...LAB_FEEDS.map((feed) => createRssPoller(db, feed)),
];
for (const poller of pollers) scheduler.register(poller);
// PHASE-3 backlog: GitHub stars poller (§4, lowest priority — not built).

// PHASE-4: read API + SSE. Staleness derives from each poller's cadence.
registerApiRoutes(app, db, new Map(pollers.map((p) => [p.name, p.cadence])));
const sse = new SseHub(db);
sse.register(app);
scheduler.onRunComplete = (source, ok) => sse.handleRunComplete(source, ok);

scheduler.start();

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[argus] server listening on http://localhost:${info.port}`);
});