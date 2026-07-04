import { COMMANDS, findCommand } from '@argus/shared';
import type { ArgSpec, CommandSpec, SearchResult } from '@argus/shared';

/**
 * HARD COMPONENT 2 (§7, tested): the command parser.
 * Pipeline: tokenize → parseTokens (pure grammar/arg validation) →
 * resolveEntities (async, via injected /api/search resolver) → Dispatch.
 *
 * Grammar: [ENTITY] FUNCTION [ARGS]. Function-first forms are legal where §7
 * uses them ("ARENA TEXT", "NEWS FABLE5", "BENCH A B C", "WATCH ADD X").
 * A bare entity with no function dispatches DES, Bloomberg-style.
 * All errors render inline in the command line — the messages here ARE the UI.
 */

export interface Dispatch {
  spec: CommandSpec;
  /** Resolved in query order; DES target, BENCH list, WATCH subject, ... */
  entities: SearchResult[];
  /** Arg name → API value (ArgSpec.mapTo applied). */
  args: Record<string, string>;
}

export type CommandError =
  | { code: 'EMPTY'; message: string }
  | { code: 'UNKNOWN_FUNCTION'; message: string }
  | { code: 'BAD_ARGS'; message: string }
  | { code: 'UNKNOWN_ENTITY'; message: string }
  | { code: 'AMBIGUOUS_ENTITY'; message: string; candidates: SearchResult[] };

export type EntityResolver = (query: string) => Promise<SearchResult[]>;

export function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter((t) => t.length > 0);
}

/* ------------------------------ parse stage ------------------------------ */

export interface Parsed {
  spec: CommandSpec;
  /** Raw entity query strings, still unresolved. */
  entityQueries: string[];
  args: Record<string, string>;
  /** True when input was a bare entity and DES was implied. */
  implicitDes: boolean;
}

const BENCH_MIN = 2;
const BENCH_MAX = 5;

function badArgs(spec: CommandSpec, detail: string): CommandError {
  return { code: 'BAD_ARGS', message: `BAD ARGS — ${detail} · USAGE: ${spec.usage}` };
}

export function parseTokens(tokens: string[]): Parsed | CommandError {
  if (tokens.length === 0) return { code: 'EMPTY', message: '' };

  const fnIndex = tokens.findIndex((t) => findCommand(t) !== undefined);

  if (fnIndex === -1) {
    // No function anywhere: the whole input is an entity → implicit DES.
    const spec = findCommand('DES') as CommandSpec;
    return { spec, entityQueries: [tokens.join(' ')], args: {}, implicitDes: true };
  }

  const spec = findCommand(tokens[fnIndex] as string) as CommandSpec;
  const leading = tokens.slice(0, fnIndex).join(' ');
  const rest = tokens.slice(fnIndex + 1);

  if (spec.entity === 'list') {
    // BENCH: every remaining token is an entity; a leading entity joins the list.
    const queries = [...(leading ? [leading] : []), ...rest];
    if (queries.length < BENCH_MIN || queries.length > BENCH_MAX) {
      return badArgs(spec, `EXPECTED ${BENCH_MIN}-${BENCH_MAX} ENTITIES, GOT ${queries.length}`);
    }
    return { spec, entityQueries: queries, args: {}, implicitDes: false };
  }

  if (spec.entity === 'none' && leading) {
    return badArgs(spec, `${spec.fn} TAKES NO ENTITY`);
  }

  // Consume rest tokens against the arg specs in order.
  const args: Record<string, string> = {};
  const entityQueries: string[] = leading ? [leading] : [];
  let cursor = 0;
  for (const arg of spec.args) {
    const token = rest[cursor];
    if (token === undefined) break;
    if (arg.kind === 'enum') {
      const upper = token.toUpperCase();
      if (arg.values?.includes(upper)) {
        args[arg.name] = arg.mapTo?.[upper] ?? upper;
        cursor++;
      } else if (arg.required) {
        return badArgs(spec, `EXPECTED ${arg.name.toUpperCase()} (${arg.values?.join('|')})`);
      }
      // optional enum not matching: leave for entity/leftover handling
    } else {
      // entity-kind arg (WATCH ADD <entity>)
      entityQueries.push(token);
      cursor++;
    }
  }

  // Required args must all have been consumed (a required enum with no token
  // at all would otherwise slip through the loop's early break).
  for (const arg of spec.args) {
    if (arg.required && !(arg.name in args)) {
      return badArgs(spec, `EXPECTED ${arg.name.toUpperCase()} (${arg.values?.join('|')})`);
    }
  }

  const leftover = rest.slice(cursor);
  if (leftover.length > 0) {
    // Unconsumed tokens are the inline entity ("NEWS FABLE5", "DES claude opus")
    // when the entity slot is open; anything else is a bad arg.
    if ((spec.entity === 'optional' || spec.entity === 'required') && entityQueries.length === 0) {
      entityQueries.push(leftover.join(' '));
    } else {
      return badArgs(spec, `UNEXPECTED '${leftover.join(' ').toUpperCase()}'`);
    }
  }

  if (spec.entity === 'required' && entityQueries.length === 0) {
    return badArgs(spec, 'ENTITY REQUIRED');
  }

  // WATCH's dependent pair (ADD|RM requires an entity, entity requires an
  // action) is the one rule the flat ArgSpec shape can't express.
  if (spec.fn === 'WATCH') {
    const action = args['action'];
    if (action !== undefined && entityQueries.length === 0) {
      return badArgs(spec, `WATCH ${action} REQUIRES AN ENTITY`);
    }
    if (action === undefined && entityQueries.length > 0) {
      return badArgs(spec, 'EXPECTED ADD OR RM');
    }
  }

  return { spec, entityQueries, args, implicitDes: false };
}

/* ---------------------------- resolution stage ---------------------------- */

/** Score gap below which two candidates are "too close to call". */
const AMBIGUITY_GAP = 12;

export type EntityPick =
  | { kind: 'hit'; result: SearchResult }
  | { kind: 'ambiguous'; candidates: SearchResult[] }
  | { kind: 'miss' };

export function pickEntity(query: string, results: SearchResult[]): EntityPick {
  const first = results[0];
  if (first === undefined) return { kind: 'miss' };
  const q = query.toUpperCase();
  const exact = results.find(
    (r) => r.ticker?.toUpperCase() === q || r.name.toUpperCase() === q || r.id === query.toLowerCase(),
  );
  if (exact) return { kind: 'hit', result: exact };
  const second = results[1];
  if (second === undefined || first.score - second.score >= AMBIGUITY_GAP) {
    return { kind: 'hit', result: first };
  }
  return { kind: 'ambiguous', candidates: results.slice(0, 3) };
}

export async function executeCommand(
  input: string,
  resolver: EntityResolver,
): Promise<Dispatch | CommandError> {
  const parsed = parseTokens(tokenize(input));
  if ('code' in parsed) return parsed;

  const entities: SearchResult[] = [];
  for (const query of parsed.entityQueries) {
    const pick = pickEntity(query, await resolver(query));
    if (pick.kind === 'miss') {
      return {
        code: 'UNKNOWN_ENTITY',
        message: parsed.implicitDes
          ? `UNKNOWN FUNCTION OR ENTITY '${query.toUpperCase()}'`
          : `UNKNOWN ENTITY '${query.toUpperCase()}'`,
      };
    }
    if (pick.kind === 'ambiguous') {
      const names = pick.candidates.map((c) => c.ticker ?? c.id).join('  ');
      return {
        code: 'AMBIGUOUS_ENTITY',
        message: `AMBIGUOUS ENTITY '${query.toUpperCase()}' — ${names}`,
        candidates: pick.candidates,
      };
    }
    entities.push(pick.result);
  }

  // Entity lists (BENCH) must resolve to distinct models — "BENCH FABLE5
  // fable-5" collapses to one column, which is not a comparison.
  if (parsed.spec.entity === 'list') {
    const unique = [...new Map(entities.map((e) => [e.id, e])).values()];
    if (unique.length < 2) {
      return {
        code: 'BAD_ARGS',
        message: `BAD ARGS — ENTITIES RESOLVE TO ${unique.length} DISTINCT MODEL · USAGE: ${parsed.spec.usage}`,
      };
    }
    return { spec: parsed.spec, entities: unique, args: parsed.args };
  }

  return { spec: parsed.spec, entities, args: parsed.args };
}

/* ------------------------------- ghost text ------------------------------ */

/**
 * Static autocomplete for the token being typed: function names, then enum
 * values for the next open arg. Entity ghosting is async and merged by the
 * command line on top of this. Returns the REMAINDER to ghost, or null.
 */
export function suggest(input: string): string | null {
  if (input === '' || /\s$/.test(input)) return null;
  const tokens = tokenize(input);
  const current = (tokens[tokens.length - 1] as string).toUpperCase();
  const priorTokens = tokens.slice(0, -1);
  const fnAlready = priorTokens.some((t) => findCommand(t) !== undefined);

  const candidates: string[] = [];
  if (!fnAlready) {
    // Completing the function (or a leading entity — async layer covers that).
    candidates.push(...COMMANDS.map((c) => c.fn));
  } else {
    const spec = priorTokens.map((t) => findCommand(t)).find((s) => s !== undefined) as CommandSpec;
    const consumed = new Set(
      priorTokens
        .slice(priorTokens.findIndex((t) => findCommand(t) !== undefined) + 1)
        .map((t) => t.toUpperCase()),
    );
    for (const arg of spec.args) {
      if (arg.kind !== 'enum' || !arg.values) continue;
      if (arg.values.some((v) => consumed.has(v))) continue;
      candidates.push(...arg.values);
    }
  }

  const hit = candidates.find((c) => c.startsWith(current) && c !== current);
  return hit ? hit.slice(current.length) : null;
}

export type { ArgSpec };