import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { Panel } from '../components/Panel';
import { useEnvelope } from '../hooks/useEnvelope';
import { dispatchFn, entityRef } from '../lib/dispatch';
import { fmtTime } from '../lib/fmt';
import common from './common.module.css';
import styles from './Bench.module.css';

/** Lower is better only for prices; every other row is higher-is-better. */
function lowerIsBetter(key: string): boolean {
  return key.includes('usd_per_mtok');
}

function fmtCell(key: string, v: number): string {
  if (key.includes('usd_per_mtok')) return `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;
  if (key === 'context_len') return v.toLocaleString('en-US');
  if (key.startsWith('arena_elo')) return String(Math.round(v));
  return v.toFixed(1);
}

/** BENCH — 2-5 model comparison matrix; best-in-row amber; gaps honest. */
export function Bench({ dispatch }: { dispatch: Dispatch }) {
  const ids = dispatch.entities.map((e) => e.id);

  const { env, error, loading } = useEnvelope(
    () => api.compare(ids),
    [ids.join(',')],
    (e) => e.type === 'snapshot' && e.model_ids.some((id) => ids.includes(id)),
  );

  const d = env?.data;

  return (
    <Panel
      fn="BENCH"
      desc={`compare · ${dispatch.entities.map((e) => e.ticker ?? e.id).join(' vs ')}`}
      meta={env ? `AS OF ${fmtTime(env.asOf)}` : undefined}
      stale={env?.stale}
    >
      {loading ? (
        <div className={common.note}>LOADING…</div>
      ) : error ? (
        <div className={common.error}>API ERROR — {error}</div>
      ) : !d ? (
        <div className={common.note}>NO DATA</div>
      ) : (
        <table className={styles.matrix}>
          <colgroup>
            <col style={{ width: '34ch' }} />
            {d.models.map((m) => (
              <col key={m.id} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className={common.label}>METRIC</th>
              {d.models.map((m) => (
                <th key={m.id}>
                  <span
                    className={common.ticker}
                    onClick={() => dispatchFn('DES', [entityRef(m.id, m.ticker ?? m.id)])}
                  >
                    {m.ticker ?? m.id.split('/').pop()?.toUpperCase()}
                  </span>
                  <span className={`${styles.openbadge} ${m.openness === 'open' ? common.up : common.dim}`}>
                    {m.openness === 'open' ? 'OPEN' : 'CLSD'}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((row) => {
              const present = row.values.filter((v): v is number => v !== null);
              const best =
                present.length > 0
                  ? lowerIsBetter(row.key)
                    ? Math.min(...present)
                    : Math.max(...present)
                  : null;
              // A row where everyone ties has no winner to highlight.
              const highlight = best !== null && present.some((v) => v !== best);
              return (
                <tr key={`${row.source}/${row.key}`}>
                  <td>
                    <span className={styles.rowkey}>{row.key.toUpperCase()}</span>
                    <span className={styles.rowsource}>{row.source.toUpperCase()}</span>
                  </td>
                  {row.values.map((v, i) => (
                    <td
                      key={d.models[i]?.id ?? i}
                      className={
                        v === null ? styles.missing : highlight && v === best ? styles.best : styles.value
                      }
                    >
                      {v === null ? '—' : fmtCell(row.key, v)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}