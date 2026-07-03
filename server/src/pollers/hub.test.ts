import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { EntityResolver } from '../resolver/entity-resolver';
import { ingestHubModels } from './hub';
import { ingestOpenRouterModels } from './openrouter';

const SCHEMA = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/${rel}`, import.meta.url)), 'utf8'));
const OPENROUTER = readJson('openrouter-models.json');
const HF_LIST = readJson('hf-models.json');
const HF_TRENDING = readJson('hf-trending.json');

const T1 = '2026-07-03T12:00:00.000Z';

describe('ingestHubModels (real fixtures)', () => {
  let db: Database.Database;
  let resolver: EntityResolver;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    resolver = new EntityResolver(db);
    ingestOpenRouterModels(db, resolver, OPENROUTER, '2026-07-03T00:00:00.000Z');
  });

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  it('writes snapshots, joins known models via hf alias, creates the long tail', () => {
    const before = count(`SELECT COUNT(*) AS n FROM model`);
    const stats = ingestHubModels(db, resolver, HF_LIST, HF_TRENDING, T1);

    expect(stats.snapshots).toBeGreaterThan(400);
    expect(stats.created).toBeGreaterThan(0);
    expect(count(`SELECT COUNT(*) AS n FROM model`)).toBe(before + stats.created);
    // known-entity join: some snapshots landed on models that existed before
    expect(stats.snapshots).toBeGreaterThan(stats.created);
    // trending ranks recorded for the trending slice
    expect(count(`SELECT COUNT(*) AS n FROM hub_snapshot WHERE trending_rank IS NOT NULL`)).toBeGreaterThan(10);
    // every created model is open and gets a ticker
    expect(count(`SELECT COUNT(*) AS n FROM model WHERE ticker IS NULL`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM model WHERE openness = 'open' AND license IS NOT NULL`)).toBeGreaterThan(100);
  });

  it('enriches licenses that Phase 2 left NULL on OpenRouter-known open models', () => {
    // Track the specific pre-existing NULL-license set: created long-tail
    // models must not pollute the measurement.
    const nullIds = (
      db.prepare(`SELECT id FROM model WHERE openness = 'open' AND license IS NULL`).all() as { id: string }[]
    ).map((r) => r.id);
    expect(nullIds.length).toBeGreaterThan(50); // Phase 2 left these pending exactly this poller

    ingestHubModels(db, resolver, HF_LIST, HF_TRENDING, T1);

    const get = db.prepare(`SELECT license FROM model WHERE id = ?`);
    const enriched = nullIds.filter((id) => (get.get(id) as { license: string | null }).license !== null);
    expect(enriched.length).toBeGreaterThan(10);

    // Regression: a later OpenRouter cycle must not clobber enriched licenses
    ingestOpenRouterModels(db, resolver, OPENROUTER, '2026-07-03T13:00:00.000Z');
    const survived = nullIds.filter((id) => (get.get(id) as { license: string | null }).license !== null);
    expect(survived.length).toBe(enriched.length);
  });

  it('re-running the same cycle is a no-op for models and snapshots', () => {
    ingestHubModels(db, resolver, HF_LIST, HF_TRENDING, T1);
    const models = count(`SELECT COUNT(*) AS n FROM model`);
    const snaps = count(`SELECT COUNT(*) AS n FROM hub_snapshot`);
    const stats2 = ingestHubModels(db, resolver, HF_LIST, HF_TRENDING, T1);
    expect(stats2.created).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM model`)).toBe(models);
    expect(count(`SELECT COUNT(*) AS n FROM hub_snapshot`)).toBe(snaps);
  });
});
