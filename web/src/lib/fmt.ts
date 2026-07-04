/** Number/time formatting per §8: $X.XX/MTOK, signed colored deltas, ▲/▼. */

export function fmtPrice(usd: number | null): string {
  if (usd === null) return '—';
  return `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

export function fmtPct(pct: number | null): string {
  if (pct === null) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export function fmtDelta(n: number | null, digits = 0): string {
  if (n === null || n === 0) return '—';
  return `${n > 0 ? '▲' : '▼'}${Math.abs(n).toFixed(digits)}`;
}

export function deltaClass(n: number | null): string {
  if (n === null || n === 0) return '';
  return n > 0 ? 'up' : 'down';
}

export function fmtInt(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString('en-US');
}

/** Compact download counts: 28,146,342 → 28.1M. */
export function fmtCompact(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(11, 16) || ts;
  return d.toTimeString().slice(0, 5);
}

export function fmtDate(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Short display code for a source_status name (status bar dots). */
const SOURCE_CODES: Record<string, string> = {
  openrouter: 'OR',
  lmarena: 'ARENA',
  'hf-hub': 'HF',
  hn: 'HN',
  arxiv: 'ARX',
  'rss:openai': 'OAI',
  'rss:google-deepmind': 'GDM',
  'rss:qwen': 'QWEN',
};

export function sourceCode(source: string): string {
  return SOURCE_CODES[source] ?? source.replace(/^rss:/, '').toUpperCase().slice(0, 6);
}