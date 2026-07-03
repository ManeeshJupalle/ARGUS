import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { EntityResolver } from '../../resolver/entity-resolver';
import { ingestOpenRouterModels } from '../openrouter';
import { buildMentionIndex, extractMentions, type MentionIndex } from './mentions';

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');
const OPENROUTER: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/openrouter-models.json', import.meta.url)), 'utf8'),
);

describe('mention extraction (index built from real entity table)', () => {
  let index: MentionIndex;

  beforeAll(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    ingestOpenRouterModels(db, new EntityResolver(db), OPENROUTER, '2026-07-03T00:00:00.000Z');
    index = buildMentionIndex(db);
  });

  it('finds models by display name in headlines', () => {
    expect(extractMentions(index, 'Claude Fable 5 tops the arena leaderboard')).toContain(
      'anthropic/claude-fable-5',
    );
  });

  it('finds models by slug-ish spellings and punctuation variants', () => {
    expect(extractMentions(index, 'OpenAI ships a GPT-5.5 update')).toContain('openai/gpt-5.5');
    expect(extractMentions(index, 'deepseek-r1 distilled to 1.5B')).toContain('deepseek/deepseek-r1');
  });

  it('stays silent on generic vocabulary', () => {
    expect(extractMentions(index, 'The best pro models are getting cheaper fast')).toEqual([]);
  });
});
