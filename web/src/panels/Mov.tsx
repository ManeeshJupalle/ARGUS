import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { Panel } from '../components/Panel';
import { useEnvelope } from '../hooks/useEnvelope';
import { dispatchFn, entityRef } from '../lib/dispatch';
import { deltaClass, fmtCompact, fmtDelta, fmtPct, fmtPrice, fmtTime } from '../lib/fmt';
import common from './common.module.css';

/** MOV — movers detail: price cuts, arena rank jumps, download spikes. */
export function Mov({ dispatch: _d }: { dispatch: Dispatch }) {
  const { env, error, loading } = useEnvelope(
    () => api.overview(),
    [],
    (e) => e.type === 'snapshot',
  );
  const d = env?.data;

  const code = (id: string, ticker: string | null): string =>
    ticker ?? id.split('/').pop()?.toUpperCase() ?? id;
  const open = (id: string, ticker: string | null) => dispatchFn('DES', [entityRef(id, code(id, ticker))]);

  return (
    <Panel fn="MOV" desc="Top movers · 24H/7D" meta={env ? `AS OF ${fmtTime(env.asOf)}` : undefined} stale={env?.stale}>
      {loading ? (
        <div className={common.note}>LOADING…</div>
      ) : error ? (
        <div className={common.error}>API ERROR — {error}</div>
      ) : !d ? (
        <div className={common.note}>NO DATA</div>
      ) : (
        <>
          <div className={common.sectiontitle}>Price movers · prompt $/MTok · Δ24H/7D</div>
          {d.price_movers.length === 0 ? (
            <div className={common.note}>ACCRUING HISTORY…</div>
          ) : (
            <table className={common.table}>
              <colgroup>
                <col style={{ width: '13ch' }} />
                <col />
                <col style={{ width: '11ch' }} />
                <col style={{ width: '10ch' }} />
                <col style={{ width: '10ch' }} />
              </colgroup>
              <tbody>
                {d.price_movers.map((m) => (
                  <tr key={m.id}>
                    <td className={common.ticker} onClick={() => open(m.id, m.ticker)}>{code(m.id, m.ticker)}</td>
                    <td className={common.white}>{m.name}</td>
                    <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>{fmtPrice(m.prompt_usd_per_mtok)}</td>
                    <td className={`${common[deltaClass(m.delta_pct_24h)] ?? common.dim} num`} style={{ textAlign: 'right' }}>{fmtPct(m.delta_pct_24h)}</td>
                    <td className={`${common[deltaClass(m.delta_pct_7d)] ?? common.dim} num`} style={{ textAlign: 'right' }}>{fmtPct(m.delta_pct_7d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className={common.sectiontitle}>Arena rank moves · text · Δ7D</div>
          {d.arena_movers.length === 0 ? (
            <div className={common.note}>NO RANK MOVES THIS WEEK</div>
          ) : (
            <table className={common.table}>
              <colgroup>
                <col style={{ width: '13ch' }} />
                <col />
                <col style={{ width: '7ch' }} />
                <col style={{ width: '8ch' }} />
                <col style={{ width: '8ch' }} />
                <col style={{ width: '9ch' }} />
              </colgroup>
              <tbody>
                {d.arena_movers.map((m) => (
                  <tr key={m.id}>
                    <td className={common.ticker} onClick={() => open(m.id, m.ticker)}>{code(m.id, m.ticker)}</td>
                    <td className={common.white}>{m.name}</td>
                    <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>#{m.rank}</td>
                    <td className={`${common[deltaClass(m.rank_delta_7d)]} num`} style={{ textAlign: 'right' }}>{fmtDelta(m.rank_delta_7d)}</td>
                    <td className={`${common.white} num`} style={{ textAlign: 'right' }}>{Math.round(m.elo)}</td>
                    <td className={`${common[deltaClass(m.elo_delta_7d)] ?? common.dim} num`} style={{ textAlign: 'right' }}>{fmtDelta(m.elo_delta_7d, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className={common.sectiontitle}>Download spikes · 7D</div>
          {d.download_spikes.length === 0 ? (
            <div className={common.note}>ACCRUING HISTORY…</div>
          ) : (
            <table className={common.table}>
              <colgroup>
                <col style={{ width: '13ch' }} />
                <col />
                <col style={{ width: '10ch' }} />
                <col style={{ width: '12ch' }} />
                <col style={{ width: '10ch' }} />
              </colgroup>
              <tbody>
                {d.download_spikes.map((m) => (
                  <tr key={m.id}>
                    <td className={common.ticker} onClick={() => open(m.id, m.ticker)}>{code(m.id, m.ticker)}</td>
                    <td className={common.white}>{m.name}</td>
                    <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>{fmtCompact(m.downloads)}</td>
                    <td className={`${common[deltaClass(m.delta_7d)] ?? common.dim} num`} style={{ textAlign: 'right' }}>
                      {m.delta_7d > 0 ? '+' : ''}{fmtCompact(m.delta_7d)}
                    </td>
                    <td className={`${common[deltaClass(m.delta_pct_7d)] ?? common.dim} num`} style={{ textAlign: 'right' }}>{fmtPct(m.delta_pct_7d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}