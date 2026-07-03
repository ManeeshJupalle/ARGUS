import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, openDb, resetDb } from './db/db';
import { ingestArenaRows, type ArenaResolutionCache } from './pollers/arena';
import { ingestHubModels } from './pollers/hub';
import { ingestArxivFeed } from './pollers/news/arxiv';
import { ingestHnHits } from './pollers/news/hn';
import { buildMentionIndex } from './pollers/news/mentions';
import { ingestRssFeed } from './pollers/news/rss';
import { ingestOpenRouterModels } from './pollers/openrouter';
import { EntityResolver } from './resolver/entity-resolver';

/**
 * Seed mode (`npm run seed`): DROPS AND REBUILDS the database, then loads
 * every checked-in fixture through the exact same ingest paths the live
 * pollers use, so a fresh clone shows a fully populated terminal offline.
 * Deterministic (fixtures + fixed SEED_TS; arena history keeps its own
 * dates) and idempotent (reset-first, so re-running yields the same DB).
 */

const SEED_TS = '2026-07-03T00:00:00.000Z';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures');
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const readText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** Arena fixtures store {config, rows: [...]} — see scratch fetch provenance in the files. */
const arenaRows = (name: string): unknown[] =>
  (readJson(name) as { rows: unknown[] }).rows;

const db = openDb();
console.log(`[seed] resetting database at ${DB_PATH}`);
resetDb(db);

const resolver = new EntityResolver(db);

// 1. OpenRouter — the market backbone; creates the entity table.
const or = ingestOpenRouterModels(db, resolver, readJson('openrouter-models.json'), SEED_TS);
console.log(`[seed] openrouter: ${or.models} models, ${or.priceSnapshots} price snapshots, ${or.benchScores} bench scores`);

// 2. LMArena — current boards + sampled history (powers ARENA charts offline).
const cache: ArenaResolutionCache = new Map();
const asOverall = (name: string) => (cat: string): string => (cat === 'overall' ? name : cat);
let arenaInserted = 0;
arenaInserted += ingestArenaRows(db, resolver, arenaRows('arena-text-latest.json'), asOverall('text'), cache).inserted;
arenaInserted += ingestArenaRows(db, resolver, arenaRows('arena-text-history.json'), asOverall('text'), cache).inserted;
arenaInserted += ingestArenaRows(db, resolver, arenaRows('arena-vision-latest.json'), asOverall('vision'), cache).inserted;
arenaInserted += ingestArenaRows(db, resolver, arenaRows('arena-webdev-latest.json'), asOverall('webdev'), cache).inserted;
const arenaMatched = [...cache.values()].filter((v) => v !== null).length;
console.log(
  `[seed] lmarena: ${arenaInserted} snapshots, ${arenaMatched}/${cache.size} names resolved ` +
    `(${((arenaMatched / Math.max(cache.size, 1)) * 100).toFixed(1)}%), ${cache.size - arenaMatched} quarantined`,
);

// 3. HF Hub — open-weight market + license enrichment.
const hub = ingestHubModels(db, resolver, readJson('hf-models.json'), readJson('hf-trending.json'), SEED_TS);
console.log(`[seed] hf-hub: ${hub.snapshots} snapshots, ${hub.created} long-tail models, ${hub.enrichedLicenses} licenses`);

// 4. News — mentions run against the now-populated entity table.
const index = buildMentionIndex(db);
const hn = ingestHnHits(db, index, readJson('hn-search.json'));
const rss =
  ingestRssFeed(db, index, 'openai', readText('rss-openai.xml')).inserted +
  ingestRssFeed(db, index, 'google-deepmind', readText('rss-deepmind.xml')).inserted +
  ingestRssFeed(db, index, 'qwen', readText('rss-qwen.xml')).inserted;
const arxiv = ingestArxivFeed(db, index, readText('arxiv-sample.xml'));
console.log(`[seed] news: ${hn.inserted} hn + ${rss} rss + ${arxiv.inserted} arxiv items`);

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
console.log(
  `[seed] done: ${count('model')} models, ${count('price_snapshot')} price, ${count('arena_snapshot')} arena, ` +
    `${count('hub_snapshot')} hub, ${count('bench_score')} bench, ${count('news_item')} news, ` +
    `${count('entity_alias')} aliases, ${count('quarantine')} quarantined`,
);
db.close();
