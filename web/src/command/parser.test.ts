import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@argus/shared';
import { CommandHistory } from './history';
import {
  executeCommand,
  parseTokens,
  pickEntity,
  suggest,
  tokenize,
  type CommandError,
  type Dispatch,
  type EntityResolver,
} from './parser';

/* ------------------------------ fake resolver ----------------------------- */

const DB: SearchResult[] = [
  { id: 'anthropic/claude-fable-5', ticker: 'FABLE5', name: 'Claude Fable 5', via: 'ticker', score: 95 },
  { id: 'openai/gpt-5.5', ticker: 'GPT55', name: 'GPT-5.5', via: 'ticker', score: 94 },
  { id: 'google/gemini-3.1-pro-preview', ticker: 'GEMINI31PR', name: 'Gemini 3.1 Pro', via: 'ticker', score: 90 },
  { id: 'qwen/qwen3-32b', ticker: 'QWEN32B', name: 'Qwen3 32B', via: 'ticker', score: 93.6 },
  { id: 'qwen/qwen3-4b', ticker: 'QWEN34B', name: 'Qwen3 4B', via: 'ticker', score: 93.6 },
];

const resolver: EntityResolver = (query) => {
  const q = query.toLowerCase();
  return Promise.resolve(
    DB.filter(
      (r) =>
        r.ticker?.toLowerCase().startsWith(q) ||
        r.name.toLowerCase().includes(q) ||
        r.id.includes(q),
    ),
  );
};

const run = (input: string): Promise<Dispatch | CommandError> => executeCommand(input, resolver);
const isError = (r: Dispatch | CommandError): r is CommandError => 'code' in r;

async function dispatchOf(input: string): Promise<Dispatch> {
  const r = await run(input);
  if (isError(r)) throw new Error(`expected dispatch for "${input}", got ${r.code}: ${r.message}`);
  return r;
}

async function errorOf(input: string): Promise<CommandError> {
  const r = await run(input);
  if (!isError(r)) throw new Error(`expected error for "${input}", got dispatch ${r.spec.fn}`);
  return r;
}

/* -------------------------------- tokenizer ------------------------------- */

describe('tokenize', () => {
  it('splits on runs of whitespace and trims', () => {
    expect(tokenize('  FABLE5   PX  90D ')).toEqual(['FABLE5', 'PX', '90D']);
  });
  it('returns [] for empty/blank input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
  it('preserves token case for entity queries', () => {
    expect(tokenize('claude opus DES')).toEqual(['claude', 'opus', 'DES']);
  });
});

/* --------------------------- dispatch per §7 form -------------------------- */

describe('dispatch — every v1 function signature', () => {
  it('TOP', async () => {
    const d = await dispatchOf('TOP');
    expect(d.spec.fn).toBe('TOP');
    expect(d.entities).toEqual([]);
  });

  it('FABLE5 DES (entity-first)', async () => {
    const d = await dispatchOf('FABLE5 DES');
    expect(d.spec.fn).toBe('DES');
    expect(d.entities[0]?.id).toBe('anthropic/claude-fable-5');
  });

  it('DES FABLE5 (function-first inline entity)', async () => {
    const d = await dispatchOf('DES FABLE5');
    expect(d.spec.fn).toBe('DES');
    expect(d.entities[0]?.ticker).toBe('FABLE5');
  });

  it('bare entity implies DES (Bloomberg style)', async () => {
    const d = await dispatchOf('FABLE5');
    expect(d.spec.fn).toBe('DES');
    expect(d.entities[0]?.ticker).toBe('FABLE5');
  });

  it('multi-word entity before function', async () => {
    const d = await dispatchOf('claude fable DES');
    expect(d.entities[0]?.id).toBe('anthropic/claude-fable-5');
  });

  it('FABLE5 PX 90D maps range to API value', async () => {
    const d = await dispatchOf('FABLE5 PX 90D');
    expect(d.spec.fn).toBe('PX');
    expect(d.args).toEqual({ range: '90d' });
  });

  it('PX without range: arg omitted (panel default applies)', async () => {
    const d = await dispatchOf('FABLE5 PX');
    expect(d.args).toEqual({});
  });

  it('FABLE5 ARENA CODE maps CODE → coding', async () => {
    const d = await dispatchOf('FABLE5 ARENA CODE');
    expect(d.spec.fn).toBe('ARENA');
    expect(d.args).toEqual({ category: 'coding' });
    expect(d.entities[0]?.ticker).toBe('FABLE5');
  });

  it('ARENA TEXT: board view, no entity', async () => {
    const d = await dispatchOf('ARENA TEXT');
    expect(d.entities).toEqual([]);
    expect(d.args).toEqual({ category: 'text' });
  });

  it('BENCH with three entities', async () => {
    const d = await dispatchOf('BENCH FABLE5 GPT55 GEMINI31PR');
    expect(d.spec.fn).toBe('BENCH');
    expect(d.entities.map((e) => e.ticker)).toEqual(['FABLE5', 'GPT55', 'GEMINI31PR']);
  });

  it('entity-first BENCH joins the list', async () => {
    const d = await dispatchOf('FABLE5 BENCH GPT55');
    expect(d.entities.map((e) => e.ticker)).toEqual(['FABLE5', 'GPT55']);
  });

  it('NEWS bare and NEWS <entity>', async () => {
    expect((await dispatchOf('NEWS')).entities).toEqual([]);
    expect((await dispatchOf('NEWS FABLE5')).entities[0]?.ticker).toBe('FABLE5');
  });

  it('WATCH bare / WATCH ADD / WATCH RM', async () => {
    expect((await dispatchOf('WATCH')).args).toEqual({});
    const add = await dispatchOf('WATCH ADD FABLE5');
    expect(add.args).toEqual({ action: 'ADD' });
    expect(add.entities[0]?.ticker).toBe('FABLE5');
    expect((await dispatchOf('WATCH RM GPT55')).args).toEqual({ action: 'RM' });
  });

  it('MKT OPEN / MKT CLOSED map to filter values', async () => {
    expect((await dispatchOf('MKT OPEN')).args).toEqual({ filter: 'open' });
    expect((await dispatchOf('MKT CLOSED')).args).toEqual({ filter: 'closed' });
  });

  it('MOV, STAT, HELP, LAYOUT 2', async () => {
    expect((await dispatchOf('MOV')).spec.fn).toBe('MOV');
    expect((await dispatchOf('STAT')).spec.fn).toBe('STAT');
    expect((await dispatchOf('HELP')).spec.fn).toBe('HELP');
    expect((await dispatchOf('LAYOUT 2')).args).toEqual({ preset: '2' });
  });

  it('is case-insensitive on functions and args', async () => {
    const d = await dispatchOf('fable5 px 30d');
    expect(d.spec.fn).toBe('PX');
    expect(d.args).toEqual({ range: '30d' });
  });
});

/* ------------------------------ arg validation ----------------------------- */

describe('arg validation failures', () => {
  it('PX with a bad range reports usage', async () => {
    const e = await errorOf('FABLE5 PX 45D');
    expect(e.code).toBe('BAD_ARGS');
    expect(e.message).toContain('USAGE');
    expect(e.message).toContain('PX [30D|90D|MAX]');
  });

  it('PX without entity', async () => {
    const e = await errorOf('PX 90D');
    expect(e.code).toBe('BAD_ARGS');
    expect(e.message).toContain('ENTITY REQUIRED');
  });

  it('BENCH with one entity / with six entities', async () => {
    expect((await errorOf('BENCH FABLE5')).message).toContain('EXPECTED 2-5');
    expect((await errorOf('BENCH A B C D E F')).message).toContain('GOT 6');
  });

  it('MKT with unknown filter', async () => {
    const e = await errorOf('MKT SIDEWAYS');
    expect(e.code).toBe('BAD_ARGS');
    expect(e.message).toContain("UNEXPECTED 'SIDEWAYS'");
  });

  it('LAYOUT 3 is not a preset', async () => {
    expect((await errorOf('LAYOUT 3')).code).toBe('BAD_ARGS');
  });

  it('bare LAYOUT requires a preset (PHASE-6)', async () => {
    const e = await errorOf('LAYOUT');
    expect(e.code).toBe('BAD_ARGS');
    expect(e.message).toContain('PRESET (1|2|4)');
  });

  it('LAYOUT 1 and LAYOUT 4 dispatch', async () => {
    expect((await dispatchOf('LAYOUT 1')).args).toEqual({ preset: '1' });
    expect((await dispatchOf('LAYOUT 4')).args).toEqual({ preset: '4' });
  });

  it('BENCH with five entities dispatches; duplicates collapse and fail', async () => {
    const five = await dispatchOf('BENCH FABLE5 GPT55 GEMINI31PR QWEN32B QWEN34B');
    expect(five.entities).toHaveLength(5);
    const dup = await errorOf('BENCH FABLE5 FABLE5');
    expect(dup.code).toBe('BAD_ARGS');
    expect(dup.message).toContain('1 DISTINCT');
  });

  it('TOP rejects a leading entity', async () => {
    const e = await errorOf('FABLE5 TOP');
    expect(e.message).toContain('TAKES NO ENTITY');
  });

  it('WATCH ADD without entity; WATCH with entity but no action', async () => {
    expect((await errorOf('WATCH ADD')).message).toContain('REQUIRES AN ENTITY');
    expect((await errorOf('WATCH FABLE5')).message).toContain('EXPECTED ADD OR RM');
  });
});

/* ------------------------- entity resolution rules ------------------------- */

describe('entity resolution', () => {
  it('unknown function-or-entity for bare garbage', async () => {
    const e = await errorOf('FLURB');
    expect(e.code).toBe('UNKNOWN_ENTITY');
    expect(e.message).toBe("UNKNOWN FUNCTION OR ENTITY 'FLURB'");
  });

  it('unknown entity with explicit function', async () => {
    const e = await errorOf('FLURB DES');
    expect(e.code).toBe('UNKNOWN_ENTITY');
    expect(e.message).toBe("UNKNOWN ENTITY 'FLURB'");
  });

  it('ambiguous when top scores are within the gap', async () => {
    const e = await errorOf('QWEN3 DES');
    expect(e.code).toBe('AMBIGUOUS_ENTITY');
    expect(e.message).toContain("AMBIGUOUS ENTITY 'QWEN3'");
    expect(e.message).toContain('QWEN32B');
    expect(e.message).toContain('QWEN34B');
  });

  it('exact ticker match wins even with close seconds', () => {
    const results: SearchResult[] = [
      { id: 'a/x', ticker: 'QWEN32B', name: 'X', via: 'ticker', score: 90 },
      { id: 'b/y', ticker: 'QWEN32BX', name: 'Y', via: 'ticker', score: 89 },
    ];
    const pick = pickEntity('QWEN32B', results);
    expect(pick).toMatchObject({ kind: 'hit', result: { id: 'a/x' } });
  });

  it('clear score gap resolves without exact match', () => {
    const results: SearchResult[] = [
      { id: 'a/x', ticker: 'FABLE5', name: 'X', via: 'ticker', score: 93 },
      { id: 'b/y', ticker: 'GEMMA', name: 'Y', via: 'name', score: 61 },
    ];
    expect(pickEntity('fab', results)).toMatchObject({ kind: 'hit', result: { id: 'a/x' } });
  });
});

/* --------------------------------- ghost ---------------------------------- */

describe('suggest (static ghost text)', () => {
  it('completes function names', () => {
    expect(suggest('TO')).toBe('P');
    expect(suggest('LAY')).toBe('OUT');
  });
  it('completes enum args after a function', () => {
    expect(suggest('FABLE5 PX 9')).toBe('0D');
    expect(suggest('MKT O')).toBe('PEN');
    expect(suggest('ARENA WEB')).toBe('DEV');
  });
  it('no ghost on trailing space, empty input, or full match', () => {
    expect(suggest('')).toBeNull();
    expect(suggest('TOP ')).toBeNull();
    expect(suggest('TOP')).toBeNull();
  });
});

/* -------------------------------- history --------------------------------- */

describe('CommandHistory', () => {
  it('navigates up and down and returns to the live line', () => {
    const h = new CommandHistory();
    h.push('TOP');
    h.push('FABLE5 DES');
    expect(h.prev()).toBe('FABLE5 DES');
    expect(h.prev()).toBe('TOP');
    expect(h.prev()).toBe('TOP'); // clamps at oldest
    expect(h.next()).toBe('FABLE5 DES');
    expect(h.next()).toBeNull(); // live line
  });

  it('skips consecutive duplicates and blank commands', () => {
    const h = new CommandHistory();
    h.push('TOP');
    h.push('TOP');
    h.push('   ');
    expect(h.prev()).toBe('TOP');
    expect(h.prev()).toBe('TOP');
  });

  it('parseTokens is pure — same tokens, same result', () => {
    const a = parseTokens(['FABLE5', 'PX', '90D']);
    const b = parseTokens(['FABLE5', 'PX', '90D']);
    expect(a).toEqual(b);
  });
});