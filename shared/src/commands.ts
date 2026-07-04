/**
 * PHASE-5: the §7 function registry — single source of truth for the command
 * line (tokenizer/dispatch), the HELP panel, and panel routing. Later phases
 * ADD ENTRIES ONLY (or flip `implementedInPhase`); the shape never changes.
 *
 * Grammar (§7): [ENTITY] FUNCTION [ARGS] <GO>. Function-first forms are also
 * legal where the §7 examples use them ("ARENA TEXT", "NEWS FABLE5",
 * "BENCH A B C", "WATCH ADD X").
 */

export interface ArgSpec {
  name: string;
  kind: 'enum' | 'entity';
  required: boolean;
  /** Legal tokens for enum args (uppercase, as typed). */
  values?: readonly string[];
  /** CLI token → API value ("CODE" → "coding", "30D" → "30d"). */
  mapTo?: Readonly<Record<string, string>>;
}

export interface CommandSpec {
  fn: string;
  description: string;
  /** Shown verbatim in BAD ARGS errors and HELP. */
  usage: string;
  /** Whether the command takes a leading/inline entity. 'list' = 2-5 (BENCH). */
  entity: 'none' | 'optional' | 'required' | 'list';
  args: readonly ArgSpec[];
  /** First phase whose panel really implements it; earlier phases stub. */
  implementedInPhase: number;
}

const ARENA_CATEGORIES: Readonly<Record<string, string>> = {
  TEXT: 'text',
  CODE: 'coding',
  CODING: 'coding',
  MATH: 'math',
  VISION: 'vision',
  WEBDEV: 'webdev',
  CREATIVE: 'creative_writing',
  HARD: 'hard_prompts',
  IF: 'instruction_following',
};

const RANGES: Readonly<Record<string, string>> = { '30D': '30d', '90D': '90d', MAX: 'max' };

export const COMMANDS: readonly CommandSpec[] = [
  {
    fn: 'TOP',
    description: 'MARKET OVERVIEW — MOVERS, FRONTIER GAP, LATEST NEWS',
    usage: 'TOP',
    entity: 'none',
    args: [],
    implementedInPhase: 5,
  },
  {
    fn: 'DES',
    description: 'MODEL DESCRIPTION / SPEC SHEET',
    usage: '<ENTITY> DES',
    entity: 'required',
    args: [],
    implementedInPhase: 6,
  },
  {
    fn: 'PX',
    description: 'TOKEN PRICE HISTORY CHART',
    usage: '<ENTITY> PX [30D|90D|MAX]',
    entity: 'required',
    args: [
      { name: 'range', kind: 'enum', required: false, values: Object.keys(RANGES), mapTo: RANGES },
    ],
    implementedInPhase: 6,
  },
  {
    fn: 'ARENA',
    description: 'ARENA LEADERBOARD / ELO HISTORY · CAT: TEXT CODE MATH VISION WEBDEV CREATIVE HARD IF',
    usage: '[ENTITY] ARENA [CATEGORY]',
    entity: 'optional',
    args: [
      {
        name: 'category',
        kind: 'enum',
        required: false,
        values: Object.keys(ARENA_CATEGORIES),
        mapTo: ARENA_CATEGORIES,
      },
    ],
    implementedInPhase: 6,
  },
  {
    fn: 'BENCH',
    description: 'SIDE-BY-SIDE BENCHMARK MATRIX (2-5 MODELS)',
    usage: 'BENCH <ENTITY> <ENTITY> [ENTITY...]',
    entity: 'list',
    args: [],
    implementedInPhase: 6,
  },
  {
    fn: 'NEWS',
    description: 'NEWS FEED, OPTIONALLY FILTERED BY MODEL',
    usage: 'NEWS [ENTITY]',
    entity: 'optional',
    args: [],
    implementedInPhase: 6,
  },
  {
    fn: 'WATCH',
    description: 'WATCHLIST — LIVE QUOTE BOARD / ADD / REMOVE',
    usage: 'WATCH [ADD|RM <ENTITY>]',
    entity: 'none',
    args: [
      { name: 'action', kind: 'enum', required: false, values: ['ADD', 'RM'] },
      { name: 'entity', kind: 'entity', required: false },
    ],
    implementedInPhase: 6,
  },
  {
    fn: 'MKT',
    description: 'FULL MARKET TABLE, OPEN/CLOSED FILTER',
    usage: 'MKT [OPEN|CLOSED]',
    entity: 'none',
    args: [
      {
        name: 'filter',
        kind: 'enum',
        required: false,
        values: ['OPEN', 'CLOSED'],
        mapTo: { OPEN: 'open', CLOSED: 'closed' },
      },
    ],
    implementedInPhase: 6,
  },
  {
    fn: 'MOV',
    description: 'TOP MOVERS — PRICE CUTS, RANK JUMPS, DOWNLOAD SPIKES',
    usage: 'MOV',
    entity: 'none',
    args: [],
    implementedInPhase: 6,
  },
  {
    fn: 'STAT',
    description: 'SOURCE HEALTH, POLL TIMES, ROW COUNTS',
    usage: 'STAT',
    entity: 'none',
    args: [],
    implementedInPhase: 7,
  },
  {
    fn: 'HELP',
    description: 'FUNCTION REFERENCE',
    usage: 'HELP',
    entity: 'none',
    args: [],
    implementedInPhase: 5,
  },
  {
    fn: 'LAYOUT',
    description: 'PANEL GRID PRESETS · ALT+1-4 FOCUSES A PANEL',
    usage: 'LAYOUT <1|2|4>',
    entity: 'none',
    args: [{ name: 'preset', kind: 'enum', required: true, values: ['1', '2', '4'] }],
    implementedInPhase: 6,
  },
] as const;

export function findCommand(token: string): CommandSpec | undefined {
  const fn = token.toUpperCase();
  return COMMANDS.find((c) => c.fn === fn);
}