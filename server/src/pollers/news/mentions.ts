import type Database from 'better-sqlite3';

/**
 * Model-mention extraction for news_item.model_ids: matches entity names,
 * tickers, id name-parts, and org-less aliases against headline/summary text,
 * word-boundary style over punctuation-normalized text.
 */

/** Single-token phrases too generic to ever count as a model mention. */
const STOP_PHRASES = new Set([
  'chat', 'base', 'mini', 'auto', 'fast', 'code', 'pro', 'ultra', 'plus',
  'large', 'small', 'medium', 'turbo', 'lite', 'latest', 'open', 'free',
  'nano', 'max', 'air', 'next', 'coder', 'vision', 'omni', 'expert',
]);
const MIN_PHRASE_LEN = 4;

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_./:+()[\],!?"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MentionIndex {
  phrases: Map<string, Set<string>>;
}

/** Rebuild per poll run — models/aliases grow as other pollers work. */
export function buildMentionIndex(db: Database.Database): MentionIndex {
  const phrases = new Map<string, Set<string>>();
  const add = (raw: string | null, modelId: string): void => {
    if (raw === null) return;
    const phrase = normalizeText(raw);
    if (phrase.length < MIN_PHRASE_LEN || STOP_PHRASES.has(phrase)) return;
    const set = phrases.get(phrase);
    if (set) set.add(modelId);
    else phrases.set(phrase, new Set([modelId]));
  };

  const models = db.prepare(`SELECT id, name, ticker FROM model`).all() as {
    id: string;
    name: string;
    ticker: string | null;
  }[];
  for (const m of models) {
    add(m.name, m.id);
    add(m.ticker, m.id);
    add(m.id.split('/').pop() ?? null, m.id);
  }
  const aliases = db.prepare(`SELECT alias, model_id FROM entity_alias`).all() as {
    alias: string;
    model_id: string;
  }[];
  for (const a of aliases) {
    if (!a.alias.includes('/')) add(a.alias, a.model_id);
  }
  return { phrases };
}

export function extractMentions(index: MentionIndex, text: string): string[] {
  const haystack = ` ${normalizeText(text)} `;
  const hits = new Set<string>();
  for (const [phrase, modelIds] of index.phrases) {
    if (haystack.includes(` ${phrase} `)) {
      for (const id of modelIds) hits.add(id);
    }
  }
  return [...hits].sort();
}
