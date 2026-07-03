import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { EntityResolver, canonicalizeModelId, normalizeAlias } from './entity-resolver';

const SCHEMA = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function insertModel(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO model (id, name, author_org, openness, modalities, sources)
     VALUES (?, ?, ?, 'closed', '[]', '{}')`,
  ).run(id, name, id.split('/')[0]);
}

describe('normalizeAlias', () => {
  it('lowercases, trims, slugs whitespace, drops vendor prefixes', () => {
    expect(normalizeAlias('  Claude Fable 5 ')).toBe('claude-fable-5');
    expect(normalizeAlias('Anthropic: Claude Fable 5')).toBe('claude-fable-5');
    // colon+no-space is a variant suffix, not a vendor prefix
    expect(normalizeAlias('poolside/laguna-xs-2.1:free')).toBe('poolside/laguna-xs-2.1:free');
  });
});

describe('canonicalizeModelId (deterministic rules)', () => {
  it('strips serving-variant suffixes', () => {
    expect(canonicalizeModelId('poolside/laguna-xs-2.1:free')).toBe('poolside/laguna-xs-2.1');
    expect(canonicalizeModelId('qwen/qwen-plus-2025-07-28:thinking')).toBe('qwen/qwen-plus');
  });

  it('strips every observed date-stamp form', () => {
    expect(canonicalizeModelId('qwen/qwen3.5-plus-20260420')).toBe('qwen/qwen3.5-plus'); // YYYYMMDD
    expect(canonicalizeModelId('openai/gpt-4o-2024-11-20')).toBe('openai/gpt-4o'); // YYYY-MM-DD
    expect(canonicalizeModelId('google/gemini-2.5-flash-lite-preview-09-2025')).toBe(
      'google/gemini-2.5-flash-lite-preview',
    ); // MM-YYYY
    expect(canonicalizeModelId('mistralai/mistral-large-2512')).toBe('mistralai/mistral-large'); // YYMM
    expect(canonicalizeModelId('moonshotai/kimi-k2-0905')).toBe('moonshotai/kimi-k2'); // MMDD
  });

  it('keeps 4-digit tokens that are not plausible dates', () => {
    expect(canonicalizeModelId('perplexity/r1-1776')).toBe('perplexity/r1-1776');
  });

  it('keeps size suffixes and short version numbers', () => {
    expect(canonicalizeModelId('meta-llama/llama-3.1-405b')).toBe('meta-llama/llama-3.1-405b');
    expect(canonicalizeModelId('openai/gpt-5.4-image-2')).toBe('openai/gpt-5.4-image-2');
  });
});

describe('EntityResolver', () => {
  let db: Database.Database;
  let resolver: EntityResolver;

  beforeEach(() => {
    db = openTestDb();
    insertModel(db, 'anthropic/claude-fable-5', 'Claude Fable 5');
    insertModel(db, 'openai/gpt-5.5', 'GPT-5.5');
    insertModel(db, 'mistralai/mistral-large', 'Mistral Large');
    resolver = new EntityResolver(db);
  });

  it('matches exact canonical ids', () => {
    const r = resolver.resolve({ source: 'test', raw: 'anthropic/claude-fable-5' });
    expect(r).toEqual({ status: 'matched', model_id: 'anthropic/claude-fable-5', via: 'exact', confidence: 1 });
  });

  it('matches via the alias table', () => {
    resolver.registerAlias('claude-fable-5', 'anthropic/claude-fable-5');
    const r = resolver.resolve({ source: 'test', raw: 'Claude Fable 5' });
    expect(r).toEqual({ status: 'matched', model_id: 'anthropic/claude-fable-5', via: 'alias', confidence: 1 });
  });

  it('matches via rule normalization: variant suffix', () => {
    const r = resolver.resolve({ source: 'test', raw: 'anthropic/claude-fable-5:free' });
    expect(r).toMatchObject({ status: 'matched', model_id: 'anthropic/claude-fable-5', via: 'rule' });
  });

  it('matches via rule normalization: date stamp', () => {
    const r = resolver.resolve({ source: 'test', raw: 'anthropic/claude-fable-5-20260601' });
    expect(r).toMatchObject({ status: 'matched', model_id: 'anthropic/claude-fable-5', via: 'rule' });
  });

  it('matches org-less input on a unique name part', () => {
    const r = resolver.resolve({ source: 'test', raw: 'gpt-5.5' });
    expect(r).toMatchObject({ status: 'matched', model_id: 'openai/gpt-5.5', via: 'rule' });
  });

  it('matches dash-spelled versions against dot-spelled ids (LMArena style)', () => {
    insertModel(db, 'anthropic/claude-opus-4.6', 'Claude Opus 4.6');
    const r = resolver.resolve({ source: 'lmarena', raw: 'claude-opus-4-6', allowFuzzy: false });
    expect(r).toMatchObject({ status: 'matched', model_id: 'anthropic/claude-opus-4.6', via: 'rule' });
  });

  it('strips reasoning suffixes: "-thinking" resolves to the base entity', () => {
    insertModel(db, 'anthropic/claude-opus-4.6', 'Claude Opus 4.6');
    const r = resolver.resolve({ source: 'lmarena', raw: 'claude-opus-4-6-thinking', allowFuzzy: false });
    expect(r).toMatchObject({ status: 'matched', model_id: 'anthropic/claude-opus-4.6', via: 'rule' });
  });

  it('never dot-converts size suffixes like "llama-3-8b"', () => {
    insertModel(db, 'meta-llama/llama-3.8b', 'Llama 3.8b trap');
    const r = resolver.resolve({ source: 'test', raw: 'llama-3-8b', allowFuzzy: false });
    expect(r.status).toBe('unmatched');
  });

  it('combines date-stamp and dash-version rules on org-qualified ids', () => {
    insertModel(db, 'anthropic/claude-opus-4.6', 'Claude Opus 4.6');
    const r = resolver.resolve({ source: 'test', raw: 'anthropic/claude-opus-4-6-20260215', allowFuzzy: false });
    expect(r).toMatchObject({ status: 'matched', model_id: 'anthropic/claude-opus-4.6', via: 'rule' });
  });

  it('strips chained serving-tier suffixes (budget + thinking + inner date)', () => {
    insertModel(db, 'anthropic/claude-opus-4.5', 'Claude Opus 4.5');
    const r = resolver.resolve({
      source: 'lmarena',
      raw: 'claude-opus-4-5-20251101-thinking-32k',
      allowFuzzy: false,
    });
    expect(r).toMatchObject({ status: 'matched', model_id: 'anthropic/claude-opus-4.5', via: 'rule' });
  });

  it('strips effort tiers and trailing parentheticals', () => {
    insertModel(db, 'z-ai/glm-5.2', 'GLM 5.2');
    expect(resolver.resolve({ source: 'lmarena', raw: 'glm-5.2 (max)', allowFuzzy: false })).toMatchObject({
      status: 'matched',
      model_id: 'z-ai/glm-5.2',
    });
    expect(resolver.resolve({ source: 'lmarena', raw: 'gpt-5.5-high', allowFuzzy: false })).toMatchObject({
      status: 'matched',
      model_id: 'openai/gpt-5.5',
    });
  });

  it('prefers the less-stripped entity: suffixed products that exist are never merged', () => {
    insertModel(db, 'openai/gpt-5.2', 'GPT-5.2');
    insertModel(db, 'openai/gpt-5.2-chat', 'GPT-5.2 Chat');
    const r = resolver.resolve({ source: 'lmarena', raw: 'gpt-5.2-chat-latest', allowFuzzy: false });
    expect(r).toMatchObject({ status: 'matched', model_id: 'openai/gpt-5.2-chat' });
  });

  it('allowRules: false restricts primary-slug sources to exact/alias/canonical', () => {
    insertModel(db, 'openai/gpt-5.2', 'GPT-5.2');
    const r = resolver.resolve({
      source: 'openrouter',
      raw: 'openai/gpt-5.2-chat',
      allowFuzzy: false,
      allowRules: false,
    });
    expect(r).toEqual({ status: 'unmatched', canonical_id: 'openai/gpt-5.2-chat' });
  });

  it('reports ambiguity when a name part maps to several models', () => {
    insertModel(db, 'org-a/omni-7b', 'Omni 7B (A)');
    insertModel(db, 'org-b/omni-7b', 'Omni 7B (B)');
    const r = resolver.resolve({ source: 'test', raw: 'omni-7b' });
    expect(r).toEqual({ status: 'ambiguous', candidates: ['org-a/omni-7b', 'org-b/omni-7b'] });
  });

  it('fuzzy-accepts a close misspelling above the threshold', () => {
    const r = resolver.resolve({ source: 'test', raw: 'Claude Fabel 5' });
    expect(r).toMatchObject({ status: 'matched', model_id: 'anthropic/claude-fable-5', via: 'fuzzy' });
    if (r.status === 'matched') expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('fuzzy-rejects when digit runs differ, even if strings are close', () => {
    const r = resolver.resolve({ source: 'test', raw: 'Claude Fable 4' });
    expect(r.status).toBe('unmatched');
  });

  it('fuzzy-rejects unrelated names → caller quarantines, idempotently', () => {
    const input = { source: 'lmarena', raw: 'totally-unrelated-model-9000x' };
    const r = resolver.resolve(input);
    expect(r).toEqual({ status: 'unmatched', canonical_id: 'totally-unrelated-model-9000x' });

    resolver.quarantine(input, 'no resolution', { elo: 1000 });
    resolver.quarantine(input, 'no resolution (second poll)');
    const rows = db.prepare(`SELECT * FROM quarantine`).all() as { reason: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('no resolution (second poll)');
  });

  it('never fuzzy-matches when allowFuzzy is false', () => {
    const r = resolver.resolve({ source: 'openrouter', raw: 'Claude Fabel 5', allowFuzzy: false });
    expect(r.status).toBe('unmatched');
  });

  it('registerAlias is idempotent and never rebinds an alias', () => {
    resolver.registerAlias('fable', 'anthropic/claude-fable-5');
    resolver.registerAlias('fable', 'anthropic/claude-fable-5');
    resolver.registerAlias('fable', 'openai/gpt-5.5'); // attempt to rebind
    const rows = db.prepare(`SELECT model_id FROM entity_alias WHERE alias = 'fable'`).all() as {
      model_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model_id).toBe('anthropic/claude-fable-5');
  });

  it('resolves identically on re-run (idempotent)', () => {
    const first = resolver.resolve({ source: 'test', raw: 'anthropic/claude-fable-5:free' });
    if (first.status === 'matched') resolver.registerAlias('anthropic/claude-fable-5:free', first.model_id);
    const second = resolver.resolve({ source: 'test', raw: 'anthropic/claude-fable-5:free' });
    // second run hits the learned alias before the rule, same target
    expect(second).toMatchObject({ status: 'matched', model_id: 'anthropic/claude-fable-5' });
  });
});
