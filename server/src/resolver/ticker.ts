import type Database from 'better-sqlite3';
import tickersJson from '@argus/shared/tickers.json';

/**
 * Ticker generator (§5): short display codes, e.g.
 * "anthropic/claude-fable-5" → "FABLE5". Deterministic, collision-safe,
 * overridable via the checked-in shared/src/tickers.json map (overrides are
 * applied before generation each cycle so they always win their code).
 * A ticker, once stored on a model, is never regenerated.
 */

const OVERRIDES: Record<string, string> = tickersJson;

/** Serving/format tokens that carry no identity. */
const NOISE_TOKENS = new Set(['instruct', 'chat', 'base', 'it', 'hf', 'gguf']);

const MAX_LEN = 10;
/** Above this we try dropping leading brand tokens ("claude-fable-5" → FABLE5). */
const TARGET_LEN = 8;

export function generateTicker(canonicalId: string, taken: ReadonlySet<string>): string {
  const namePart = canonicalId.split('/').pop() ?? canonicalId;
  let tokens = namePart.split(/[-._]/).filter((t) => t !== '' && !NOISE_TOKENS.has(t));
  const join = (ts: string[]): string => ts.join('').toUpperCase().replace(/[^A-Z0-9]/g, '');

  let candidate = join(tokens);
  // Too long: shed leading brand tokens while the remainder still starts with
  // a letter and keeps a digit for identity (CLAUDEFABLE5 → FABLE5).
  while (candidate.length > TARGET_LEN && tokens.length > 1) {
    const rest = join(tokens.slice(1));
    if (!/^[A-Z]/.test(rest) || !/[0-9]/.test(rest)) break;
    tokens = tokens.slice(1);
    candidate = rest;
  }
  if (candidate.length > MAX_LEN) candidate = candidate.slice(0, MAX_LEN);
  if (candidate === '') candidate = join([namePart]).slice(0, MAX_LEN) || 'MODEL';

  // Collision-safe: append 2, 3, ... within the length cap.
  const base = candidate;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = String(n);
    candidate = base.slice(0, MAX_LEN - suffix.length) + suffix;
  }
  return candidate;
}

/** Fill model.ticker wherever missing; returns how many were assigned. */
export function assignTickers(db: Database.Database): number {
  const taken = new Set<string>(
    (db.prepare(`SELECT ticker FROM model WHERE ticker IS NOT NULL`).all() as { ticker: string }[]).map(
      (r) => r.ticker,
    ),
  );
  const setTicker = db.prepare(`UPDATE model SET ticker = ? WHERE id = ?`);
  let assigned = 0;

  // Overrides first, so they can never lose their code to a generated ticker.
  for (const [id, ticker] of Object.entries(OVERRIDES)) {
    const row = db.prepare(`SELECT ticker FROM model WHERE id = ?`).get(id) as
      | { ticker: string | null }
      | undefined;
    if (!row || row.ticker === ticker || taken.has(ticker)) continue;
    setTicker.run(ticker, id);
    taken.add(ticker);
    assigned++;
  }

  const missing = db.prepare(`SELECT id FROM model WHERE ticker IS NULL ORDER BY id`).all() as {
    id: string;
  }[];
  for (const { id } of missing) {
    const ticker = generateTicker(id, taken);
    setTicker.run(ticker, id);
    taken.add(ticker);
    assigned++;
  }
  return assigned;
}
