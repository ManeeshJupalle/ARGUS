import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityResolver } from '../resolver/entity-resolver';
import { ingestOpenRouterModels } from './openrouter';

const SCHEMA = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
const FIXTURE: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/openrouter-models.json', import.meta.url)), 'utf8'),
);

const T1 = '2026-07-03T12:00:00.000Z';
const T2 = '2026-07-03T12:15:00.000Z';

describe('ingestOpenRouterModels (real fixture)', () => {
  let db: Database.Database;
  let resolver: EntityResolver;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    resolver = new EntityResolver(db);
  });

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it('one cycle populates several hundred models with sane, unique tickers', () => {
    const stats = ingestOpenRouterModels(db, resolver, FIXTURE, T1);

    expect(stats.models).toBeGreaterThan(250);
    expect(count('model')).toBe(stats.models);
    expect(stats.priceSnapshots).toBeGreaterThan(250);
    expect(stats.benchScores).toBeGreaterThan(100);
    expect(stats.skippedMalformed).toBe(0);
    expect(stats.skippedPseudo).toBeGreaterThan(0); // ~org/... aliases + openrouter/* routers

    // canonical ids: no serving variants, no pseudo-entries
    const ids = (db.prepare(`SELECT id FROM model`).all() as { id: string }[]).map((r) => r.id);
    expect(ids.every((id) => !id.includes(':') && !id.startsWith('~') && !id.startsWith('openrouter/'))).toBe(true);

    // every model gets a ticker; UNIQUE constraint guarantees no collisions
    expect(count(`model WHERE ticker IS NULL`)).toBe(0);
    const tickers = (db.prepare(`SELECT ticker FROM model`).all() as { ticker: string }[]).map((r) => r.ticker);
    expect(tickers.every((t) => /^[A-Z0-9]{1,10}$/.test(t))).toBe(true);

    // overrides + the §5 example
    const fable = db.prepare(`SELECT ticker FROM model WHERE id = 'anthropic/claude-fable-5'`).get() as
      | { ticker: string }
      | undefined;
    expect(fable?.ticker).toBe('FABLE5');
  });

  it('a second cycle adds price snapshots without duplicating models or aliases', () => {
    ingestOpenRouterModels(db, resolver, FIXTURE, T1);
    const models = count('model');
    const aliases = count('entity_alias');
    const prices = count('price_snapshot');

    const stats2 = ingestOpenRouterModels(db, resolver, FIXTURE, T2);

    expect(count('model')).toBe(models);
    expect(count('entity_alias')).toBe(aliases);
    expect(count('price_snapshot')).toBe(prices + stats2.priceSnapshots);
    expect(stats2.tickersAssigned).toBe(0); // tickers never regenerate
  });

  it('re-running the same cycle timestamp is a no-op for snapshots (idempotent)', () => {
    ingestOpenRouterModels(db, resolver, FIXTURE, T1);
    const prices = count('price_snapshot');
    const bench = count('bench_score');
    ingestOpenRouterModels(db, resolver, FIXTURE, T1);
    expect(count('price_snapshot')).toBe(prices);
    expect(count('bench_score')).toBe(bench);
  });

  it('skips malformed models individually with a log line, never crashing the poll', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = (FIXTURE as { data: Record<string, unknown>[] }).data.slice(0, 3);
    const malformed = [
      { ...good[0], id: 'badco/broken-pricing', pricing: { prompt: 42, completion: 'x' } }, // number, not string
      { ...good[1], id: 'badco/no-context', context_length: 'huge' }, // wrong type
      (({ id: _drop, ...rest }): Record<string, unknown> => rest)(good[2] as { id: string }), // id missing
    ];
    const stats = ingestOpenRouterModels(db, resolver, { data: [...good, ...malformed] }, T1);

    expect(stats.skippedMalformed).toBe(3);
    expect(stats.models).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('badco/broken-pricing');

    // malformed rows land in quarantine, and re-polling the same payload does not grow it
    expect(count(`quarantine WHERE source = 'openrouter'`)).toBe(3);
    ingestOpenRouterModels(db, resolver, { data: [...good, ...malformed] }, T2);
    expect(count(`quarantine WHERE source = 'openrouter'`)).toBe(3);
    warn.mockRestore();
  });

  it('rejects a payload whose envelope is not {data: [...]}', () => {
    expect(() => ingestOpenRouterModels(db, resolver, { models: [] }, T1)).toThrow();
  });
});
