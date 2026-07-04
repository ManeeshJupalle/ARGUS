import { useMemo } from 'react';
import type { Time } from 'lightweight-charts';
import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { Panel } from '../components/Panel';
import { PanelData } from '../components/PanelData';
import { TerminalChart, type ChartSeries } from '../components/TerminalChart';
import { useEnvelope } from '../hooks/useEnvelope';
import { dispatchFn, entityRef } from '../lib/dispatch';
import { deltaClass, fmtDelta, fmtInt, fmtTime } from '../lib/fmt';
import common from './common.module.css';
import styles from './Arena.module.css';

/** CLI code ↔ data category for the clickable category strip. */
const CATS: { code: string; value: string }[] = [
  { code: 'TEXT', value: 'text' },
  { code: 'CODING', value: 'coding' },
  { code: 'MATH', value: 'math' },
  { code: 'VISION', value: 'vision' },
  { code: 'WEBDEV', value: 'webdev' },
];

function CategoryStrip({ active, onPick }: { active: string; onPick: (v: string) => void }) {
  return (
    <span className={styles.cats}>
      {CATS.map((c) => (
        <span
          key={c.value}
          className={c.value === active ? styles.catActive : styles.cat}
          onClick={() => onPick(c.value)}
        >
          {c.code}
        </span>
      ))}
    </span>
  );
}

/** ARENA — leaderboard (no entity) or a model's ELO/rank history (entity). */
export function Arena({ dispatch }: { dispatch: Dispatch }) {
  const category = dispatch.args['category'] ?? 'text';
  const entity = dispatch.entities[0];
  return entity ? (
    <ArenaHistory dispatch={dispatch} id={entity.id} category={category} />
  ) : (
    <ArenaBoard category={category} />
  );
}

function ArenaBoard({ category }: { category: string }) {
  const state = useEnvelope(
    () => api.leaderboard(category),
    [category],
    (e) => e.type === 'snapshot' && e.fields.includes('arena'),
  );
  const { env } = state;
  const board = env?.data;

  return (
    <Panel
      fn="ARENA"
      desc={`${category} leaderboard`}
      meta={board?.board_date ? `BOARD ${board.board_date}` : undefined}
      stale={env?.stale}
    >
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={common.label}>
            {board ? `${board.rows.length} MODELS` : ''}
            {board?.prior_date ? ` · Δ7D VS ${board.prior_date}` : ''}
          </span>
          <CategoryStrip active={category} onPick={(v) => dispatchFn('ARENA', [], { category: v })} />
        </div>
        <div className={styles.body}>
          <PanelData
            state={state}
            isEmpty={(b) => b.rows.length === 0}
            emptyText={`NO BOARD FOR '${category.toUpperCase()}'`}
          >
            {(b) => (
            <table className={common.table}>
              <colgroup>
                <col style={{ width: '6ch' }} />
                <col style={{ width: '13ch' }} />
                <col />
                <col style={{ width: '7ch' }} />
                <col style={{ width: '8ch' }} />
                <col style={{ width: '9ch' }} />
                <col style={{ width: '8ch' }} />
                <col style={{ width: '8ch' }} />
                <col style={{ width: '8ch' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>RANK</th>
                  <th style={{ textAlign: 'left' }}>TICKER</th>
                  <th style={{ textAlign: 'left' }}>NAME</th>
                  <th>ELO</th>
                  <th>±CI</th>
                  <th>VOTES</th>
                  <th>ΔELO 7D</th>
                  <th>ΔRK 7D</th>
                  <th>OPEN</th>
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>
                      #{r.rank}
                    </td>
                    <td
                      className={common.ticker}
                      onClick={() => dispatchFn('DES', [entityRef(r.id, r.ticker ?? r.id)])}
                    >
                      {r.ticker ?? r.id.split('/').pop()?.toUpperCase()}
                    </td>
                    <td className={common.white}>{r.name}</td>
                    <td className={`${common.amber} num`} style={{ textAlign: 'right' }}>
                      {Math.round(r.elo)}
                    </td>
                    <td className={`${common.dim} num`} style={{ textAlign: 'right' }}>
                      {r.ci === null ? '—' : `±${r.ci.toFixed(0)}`}
                    </td>
                    <td className={`${common.white} num`} style={{ textAlign: 'right' }}>
                      {fmtInt(r.votes)}
                    </td>
                    <td className={`${common[deltaClass(r.elo_delta_7d)] ?? common.dim} num`} style={{ textAlign: 'right' }}>
                      {fmtDelta(r.elo_delta_7d, 1)}
                    </td>
                    <td className={`${common[deltaClass(r.rank_delta_7d)] ?? common.dim} num`} style={{ textAlign: 'right' }}>
                      {fmtDelta(r.rank_delta_7d)}
                    </td>
                    <td
                      className={`${r.openness === 'open' ? common.up : common.dim} num`}
                      style={{ textAlign: 'right' }}
                    >
                      {r.openness === 'open' ? 'OPEN' : 'CLSD'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </PanelData>
        </div>
      </div>
    </Panel>
  );
}

function ArenaHistory({ dispatch, id, category }: { dispatch: Dispatch; id: string; category: string }) {
  const entity = dispatch.entities[0];
  const code = entity?.ticker ?? id.toUpperCase();

  const state = useEnvelope(
    () => api.arenaSeries(id, category),
    [id, category],
    (e) => e.type === 'snapshot' && e.fields.includes('arena') && e.model_ids.includes(id),
  );
  const { env } = state;
  const points = env?.data.points ?? [];

  const series = useMemo<ChartSeries[]>(
    () => [
      {
        label: 'ELO',
        colorVar: '--amber',
        points: points.map((p) => ({ time: p.ts as Time, value: p.elo })),
        decimals: 0,
      },
      {
        label: 'RANK (INV)',
        colorVar: '--func',
        points: points.map((p) => ({ time: p.ts as Time, value: p.rank })),
        scaleId: 'left',
        invert: true,
        decimals: 0,
      },
    ],
    [points],
  );

  const last = points[points.length - 1];

  return (
    <Panel
      fn="ARENA"
      desc={`${code} · ${category} ELO history`}
      meta={env ? `AS OF ${fmtTime(env.asOf)}` : undefined}
      stale={env?.stale}
    >
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={common.ticker} onClick={() => entity && dispatchFn('DES', [entity])}>
            {code}
          </span>
          <span className={styles.elo}>{last ? Math.round(last.elo) : '—'}</span>
          <span className={common.label}>
            RANK <span className={common.white}>{last ? `#${last.rank}` : '—'}</span>
          </span>
          <span className={common.label}>
            VOTES <span className={common.white}>{last ? fmtInt(last.votes) : '—'}</span>
          </span>
          <span className={common.label}>{points.length} BOARDS</span>
          <CategoryStrip
            active={category}
            onPick={(v) => entity && dispatchFn('ARENA', [entity], { category: v })}
          />
        </div>
        <PanelData
          state={state}
          isEmpty={(d) => d.points.length === 0}
          emptyText={`NO ARENA HISTORY FOR ${code} IN '${category.toUpperCase()}'`}
        >
          {(d) =>
            d.points.length < 2 ? (
              <div className={common.note}>
                ONLY {d.points.length} BOARD IN '{category.toUpperCase()}' YET — SUB-CATEGORY HISTORY
                ACCRUES DAILY (TEXT HAS THE 2-YEAR BACKFILL)
              </div>
            ) : (
              <TerminalChart series={series} />
            )
          }
        </PanelData>
      </div>
    </Panel>
  );
}