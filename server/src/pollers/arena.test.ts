import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityResolver } from '../resolver/entity-resolver';
import { ingestArenaRows, type ArenaResolutionCache } from './arena';
import { ingestOpenRouterModels } from './openrouter';

const SCHEMA = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/${rel}`, import.meta.url)), 'utf8');
const OPENROUTER: unknown = JSON.parse(read('openrouter-models.json'));
const TEXT_LATEST = (JSON.parse(read('arena-text-latest.json')) as { rows: unknown[] }).rows;
const TEXT_HISTORY = (JSON.parse(read('arena-text-history.json')) as { rows: unknown[] }).rows;

const asText = (cat: string): string => (cat === 'overall' ? 'text' : cat);

describe('ingestArenaRows (real fixtures)', () => {
  let db: Database.Database;
  let resolver: EntityResolver;
  let cache: ArenaResolutionCache;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    resolver = new EntityResolver(db);
    ingestOpenRouterModels(db, resolver, OPENROUTER, '2026-07-03T00:00:00.000Z');
    cache = new Map();
  });

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  it('joins current-board rows to canonical models with a solid match rate', () => {
    const stats = ingestArenaRows(db, resolver, TEXT_LATEST, asText, cache);
    expect(stats.skippedMalformed).toBe(0);
    expect(stats.inserted).toBeGreaterThan(0);

    const matched = [...cache.values()].filter((v) => v !== null).length;
    // Real-world rate on current-board names is ~47%: the misses are models
    // with no OpenRouter listing at all (§10 coverage bias — gemini-3-pro,
    // ernie, grok-4.1, muse-spark...), correctly quarantined, never guessed.
    expect(matched / cache.size).toBeGreaterThan(0.4);
    expect(count(`SELECT COUNT(*) AS n FROM quarantine WHERE source = 'lmarena'`)).toBe(cache.size - matched);

    // categories map: overall → text, sub-boards keep their names
    expect(count(`SELECT COUNT(*) AS n FROM arena_snapshot WHERE category = 'text'`)).toBeGreaterThan(100);
    expect(count(`SELECT COUNT(*) AS n FROM arena_snapshot WHERE category = 'coding'`)).toBeGreaterThan(100);

    // spot-check the frontier: fable-5 is rank 1 on the current text board
    const top = db
      .prepare(`SELECT model_id, rank FROM arena_snapshot WHERE category = 'text' ORDER BY rank LIMIT 1`)
      .get() as { model_id: string; rank: number };
    expect(top).toEqual({ model_id: 'anthropic/claude-fable-5', rank: 1 });
  });

  it('backfills history as distinct dated snapshots and re-runs idempotently', () => {
    ingestArenaRows(db, resolver, TEXT_HISTORY, asText, cache);
    const dates = count(`SELECT COUNT(DISTINCT ts) AS n FROM arena_snapshot WHERE category = 'text'`);
    expect(dates).toBeGreaterThan(5); // sampled pages span 2024-08 → 2026-07

    const before = count(`SELECT COUNT(*) AS n FROM arena_snapshot`);
    const again = ingestArenaRows(db, resolver, TEXT_HISTORY, asText, cache);
    expect(count(`SELECT COUNT(*) AS n FROM arena_snapshot`)).toBe(before);
    expect(again.inserted).toBe(0);
  });

  it('skips malformed rows individually with a log line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = [TEXT_LATEST[0], { model_name: 'x', organization: 'y' }, 42];
    const stats = ingestArenaRows(db, resolver, rows, asText, cache);
    expect(stats.skippedMalformed).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
