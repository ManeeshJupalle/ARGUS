import { useMemo } from 'react';
import type { Time } from 'lightweight-charts';
import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { Panel } from '../components/Panel';
import { TerminalChart, type ChartSeries } from '../components/TerminalChart';
import { useEnvelope } from '../hooks/useEnvelope';
import { dispatchFn } from '../lib/dispatch';
import { fmtPct, fmtPrice, fmtTime } from '../lib/fmt';
import common from './common.module.css';
import styles from './Px.module.css';

const RANGES = ['30d', '90d', 'max'] as const;

/** PX — token price history (prompt + completion, $/MTok). */
export function Px({ dispatch }: { dispatch: Dispatch }) {
  const entity = dispatch.entities[0];
  const range = dispatch.args['range'] ?? '90d';
  const id = entity?.id ?? '';
  const code = entity?.ticker ?? id.toUpperCase();

  const { env, error, loading } = useEnvelope(
    () => api.prices(id, range),
    [id, range],
    (e) => e.type === 'snapshot' && e.fields.includes('price') && e.model_ids.includes(id),
  );

  const points = env?.data ?? [];
  const series = useMemo<ChartSeries[]>(
    () => [
      {
        label: 'PROMPT $/MTOK',
        colorVar: '--amber',
        points: points.map((p) => ({ time: (Date.parse(p.ts) / 1000) as Time, value: p.prompt_usd_per_mtok })),
        decimals: 2,
      },
      {
        label: 'COMPLETION $/MTOK',
        colorVar: '--func',
        points: points.map((p) => ({ time: (Date.parse(p.ts) / 1000) as Time, value: p.completion_usd_per_mtok })),
        decimals: 2,
      },
    ],
    [points],
  );

  const first = points[0];
  const last = points[points.length - 1];
  const deltaPct =
    first && last && first.prompt_usd_per_mtok > 0
      ? ((last.prompt_usd_per_mtok - first.prompt_usd_per_mtok) / first.prompt_usd_per_mtok) * 100
      : null;

  return (
    <Panel
      fn="PX"
      desc={`${code} price history`}
      meta={env ? `AS OF ${fmtTime(env.asOf)}` : undefined}
      stale={env?.stale}
    >
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={common.ticker} onClick={() => entity && dispatchFn('DES', [entity])}>
            {code}
          </span>
          <span className={styles.price}>{last ? `${fmtPrice(last.prompt_usd_per_mtok)}/MTOK` : '—'}</span>
          <span className={common.label}>
            Δ VS {range.toUpperCase()} START{' '}
            <span className={deltaPct === null || deltaPct === 0 ? common.dim : deltaPct > 0 ? common.up : common.down}>
              {deltaPct === null ? '—' : `${deltaPct > 0 ? '▲' : deltaPct < 0 ? '▼' : ''}${fmtPct(deltaPct)}`}
            </span>
          </span>
          <span className={common.label}>{points.length} TICKS</span>
          <span className={styles.ranges}>
            {RANGES.map((r) => (
              <span
                key={r}
                className={r === range ? styles.rangeActive : styles.range}
                onClick={() => entity && dispatchFn('PX', [entity], { range: r })}
              >
                {r.toUpperCase()}
              </span>
            ))}
          </span>
        </div>
        {loading ? (
          <div className={common.note}>LOADING…</div>
        ) : error ? (
          <div className={common.error}>API ERROR — {error}</div>
        ) : points.length === 0 ? (
          <div className={common.note}>NO PRICE HISTORY — MODEL IS NOT SERVED VIA OPENROUTER</div>
        ) : points.length < 2 ? (
          <div className={common.note}>
            ONLY {points.length} TICK YET — HISTORY ACCRUES EVERY 15 MINUTES
          </div>
        ) : (
          <TerminalChart series={series} />
        )}
      </div>
    </Panel>
  );
}