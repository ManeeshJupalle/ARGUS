import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { DB_PATH, getSourceStatuses, openDb, resetDb } from './db/db';
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
app.get('/api/status', (c) => c.json(getSourceStatuses(db)));
// PHASE-4: full REST read API (/api/models, /api/overview, /api/search, ...) and SSE /api/stream.

const resolver = new EntityResolver(db);
const scheduler = new Scheduler(db);
scheduler.register(createHeartbeatPoller(db));
scheduler.register(createOpenRouterPoller(db, resolver));
scheduler.register(createArenaPoller(db, resolver));
scheduler.register(createHubPoller(db, resolver));
scheduler.register(createHnPoller(db));
scheduler.register(createArxivPoller(db));
for (const feed of LAB_FEEDS) scheduler.register(createRssPoller(db, feed));
// PHASE-3 backlog: GitHub stars poller (§4, lowest priority — not built).
scheduler.start();

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[argus] server listening on http://localhost:${info.port}`);
});
