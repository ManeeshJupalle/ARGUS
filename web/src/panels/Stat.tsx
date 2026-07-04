import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { Panel } from '../components/Panel';
import { PanelData } from '../components/PanelData';
import { useEnvelope } from '../hooks/useEnvelope';
import { fmtInt, fmtTime, sourceCode } from '../lib/fmt';
import common from './common.module.css';

function fmtCadence(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 3600_000) return `${ms / 3600_000}H`;
  return `${ms / 60_000}M`;
}

function fmtLast(ts: string | null): string {
  if (!ts) return 'NEVER';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** STAT — plumbing on display: source health, poll cadences, row counts. */
export function Stat({ dispatch: _d }: { dispatch: Dispatch }) {
  const state = useEnvelope(() => api.stat(), [], (e) => e.type === 'status');
  const { env } = state;

  return (
    <Panel fn="STAT" desc="Source health · row counts" meta={env ? `AS OF ${fmtTime(env.asOf)}` : undefined}>
      <PanelData state={state}>
        {(d) => (
        <>
          <div className={common.sectiontitle}>Sources</div>
          <table className={common.table}>
            <colgroup>
              <col style={{ width: '8ch' }} />
              <col style={{ width: '20ch' }} />
              <col style={{ width: '9ch' }} />
              <col style={{ width: '19ch' }} />
              <col style={{ width: '8ch' }} />
              <col style={{ width: '10ch' }} />
              <col style={{ width: '8ch' }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>SRC</th>
                <th style={{ textAlign: 'left' }}>SOURCE</th>
                <th>CADENCE</th>
                <th>LAST OK</th>
                <th>FAILS</th>
                <th>ROWS</th>
                <th>QUAR</th>
                <th style={{ textAlign: 'left' }}>LAST ERROR</th>
              </tr>
            </thead>
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.source}>
                  <td>
                    <span className={s.consecutive_failures > 0 ? common.down : s.stale ? common.amber : common.up}>
                      ●
                    </span>{' '}
                    <span className={common.white}>{sourceCode(s.source)}</span>
                  </td>
                  <td className={common.dim}>{s.source}</td>
                  <td className={`${common.white} num`} style={{ textAlign: 'right' }}>
                    {fmtCadence(s.cadence_ms)}
                  </td>
                  <td className={`${common.dim} num`} style={{ textAlign: 'right' }}>
                    {fmtLast(s.last_success)}
                  </td>
                  <td
                    className={`${s.consecutive_failures > 0 ? common.down : common.dim} num`}
                    style={{ textAlign: 'right' }}
                  >
                    {s.consecutive_failures}
                  </td>
                  <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>
                    {s.rows === null ? '—' : fmtInt(s.rows)}
                  </td>
                  <td className={`${s.quarantined > 0 ? common.white : common.dim} num`} style={{ textAlign: 'right' }}>
                    {s.quarantined}
                  </td>
                  <td className={common.down} title={s.last_error ?? undefined}>
                    {s.last_error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className={common.sectiontitle}>Database</div>
          <table className={common.table}>
            <colgroup>
              <col style={{ width: '24ch' }} />
              <col style={{ width: '12ch' }} />
              <col style={{ width: '24ch' }} />
              <col />
            </colgroup>
            <tbody>
              <tr>
                <td className={common.label}>MODELS</td>
                <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>{fmtInt(d.totals.models)}</td>
                <td className={common.label}>OPEN / CLOSED</td>
                <td className={common.white}>
                  <span className={common.up}>{fmtInt(d.totals.open_models)}</span>
                  <span className={common.dim}> / </span>
                  {fmtInt(d.totals.models - d.totals.open_models)}
                </td>
              </tr>
              <tr>
                <td className={common.label}>PRICE SNAPSHOTS</td>
                <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>{fmtInt(d.totals.price_snapshots)}</td>
                <td className={common.label}>ARENA SNAPSHOTS</td>
                <td className={common.amber}>{fmtInt(d.totals.arena_snapshots)}</td>
              </tr>
              <tr>
                <td className={common.label}>HUB SNAPSHOTS</td>
                <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>{fmtInt(d.totals.hub_snapshots)}</td>
                <td className={common.label}>BENCH SCORES</td>
                <td className={common.amber}>{fmtInt(d.totals.bench_scores)}</td>
              </tr>
              <tr>
                <td className={common.label}>NEWS ITEMS</td>
                <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>{fmtInt(d.totals.news_items)}</td>
                <td className={common.label}>ENTITY ALIASES</td>
                <td className={common.amber}>{fmtInt(d.totals.aliases)}</td>
              </tr>
              <tr>
                <td className={common.label}>QUARANTINED ROWS</td>
                <td className={`${common.white} num`} style={{ textAlign: 'right' }}>{fmtInt(d.totals.quarantined)}</td>
                <td className={common.label}>WATCHLIST</td>
                <td className={common.white}>{fmtInt(d.totals.watchlist)}</td>
              </tr>
              <tr>
                <td className={common.label}>ARENA HISTORY SPAN</td>
                <td className={`${common.white} num`} style={{ textAlign: 'right' }} colSpan={1}>
                  {fmtInt(d.arena_span.distinct_dates)} DATES
                </td>
                <td className={common.label}>FROM / TO</td>
                <td className={common.white}>
                  {d.arena_span.min ?? '—'} <span className={common.dim}>→</span> {d.arena_span.max ?? '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </>
        )}
      </PanelData>
    </Panel>
  );
}