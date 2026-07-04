import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { FlashValue } from '../components/FlashValue';
import { Panel } from '../components/Panel';
import { useEnvelope } from '../hooks/useEnvelope';
import { dispatchFn, entityRef } from '../lib/dispatch';
import { deltaClass, fmtDelta, fmtPct, fmtPrice, fmtTime } from '../lib/fmt';
import { useArgusStore } from '../store/store';
import common from './common.module.css';

/** WATCH — live quote board of watched models. ADD/RM mutate via store.execute. */
export function Watch({ dispatch: _d }: { dispatch: Dispatch }) {
  const watchVersion = useArgusStore((s) => s.watchVersion);

  const { env, error, loading } = useEnvelope(
    () => api.watchlist(),
    [watchVersion],
    (e) => e.type === 'snapshot',
  );
  const quotes = env?.data ?? [];

  return (
    <Panel
      fn="WATCH"
      desc="watchlist quote board"
      meta={env ? `${quotes.length} WATCHED · AS OF ${fmtTime(env.asOf)}` : undefined}
      stale={env?.stale}
    >
      {loading ? (
        <div className={common.note}>LOADING…</div>
      ) : error ? (
        <div className={common.error}>API ERROR — {error}</div>
      ) : quotes.length === 0 ? (
        <div className={common.note}>WATCHLIST EMPTY — TYPE: WATCH ADD ‹TICKER› ‹GO›</div>
      ) : (
        <table className={common.table}>
          <colgroup>
            <col style={{ width: '13ch' }} />
            <col />
            <col style={{ width: '8ch' }} />
            <col style={{ width: '10ch' }} />
            <col style={{ width: '9ch' }} />
            <col style={{ width: '9ch' }} />
            <col style={{ width: '8ch' }} />
            <col style={{ width: '10ch' }} />
            <col style={{ width: '7ch' }} />
            <col style={{ width: '5ch' }} />
          </colgroup>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>TICKER</th>
              <th style={{ textAlign: 'left' }}>NAME</th>
              <th>OPEN</th>
              <th>PROMPT</th>
              <th>Δ24H</th>
              <th>Δ7D</th>
              <th>ELO</th>
              <th>ΔELO 7D</th>
              <th>RANK</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {quotes.map((q) => {
              const code = q.ticker ?? q.id.split('/').pop()?.toUpperCase() ?? q.id;
              return (
                <tr key={q.id}>
                  <td className={common.ticker} onClick={() => dispatchFn('DES', [entityRef(q.id, code)])}>
                    {code}
                  </td>
                  <td className={common.white}>{q.name}</td>
                  <td className={`${q.openness === 'open' ? common.up : common.dim} num`} style={{ textAlign: 'right' }}>
                    {q.openness === 'open' ? 'OPEN' : 'CLSD'}
                  </td>
                  <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>
                    <FlashValue watch={q.prompt_usd_per_mtok}>{fmtPrice(q.prompt_usd_per_mtok)}</FlashValue>
                  </td>
                  <td className={`${common[deltaClass(q.price_delta_pct_24h)] ?? common.dim} num`} style={{ textAlign: 'right' }}>
                    {fmtPct(q.price_delta_pct_24h)}
                  </td>
                  <td className={`${common[deltaClass(q.price_delta_pct_7d)] ?? common.dim} num`} style={{ textAlign: 'right' }}>
                    {fmtPct(q.price_delta_pct_7d)}
                  </td>
                  <td className={`${common.white} num`} style={{ textAlign: 'right' }}>
                    <FlashValue watch={q.elo === null ? null : Math.round(q.elo)}>
                      {q.elo === null ? '—' : Math.round(q.elo)}
                    </FlashValue>
                  </td>
                  <td className={`${common[deltaClass(q.elo_delta_7d)] ?? common.dim} num`} style={{ textAlign: 'right' }}>
                    {fmtDelta(q.elo_delta_7d, 1)}
                  </td>
                  <td className={`${common.dim} num`} style={{ textAlign: 'right' }}>
                    {q.arena_rank === null ? '—' : `#${q.arena_rank}`}
                  </td>
                  <td className={common.code} style={{ textAlign: 'right' }} onClick={() => dispatchFn('WATCH', [entityRef(q.id, code)], { action: 'RM' })}>
                    RM
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}