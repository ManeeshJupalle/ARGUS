import { useMemo, useRef, useState } from 'react';
import type { MarketRow } from '@argus/shared';
import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { Panel } from '../components/Panel';
import { PanelData } from '../components/PanelData';
import { useEnvelope } from '../hooks/useEnvelope';
import { dispatchFn, entityRef } from '../lib/dispatch';
import { fmtCompact, fmtDate, fmtPrice, fmtTime } from '../lib/fmt';
import common from './common.module.css';
import styles from './Mkt.module.css';

const ROW_H = 20;
const OVERSCAN = 10;

type SortKey = 'ticker' | 'prompt_usd_per_mtok' | 'context_len' | 'elo' | 'intelligence_index' | 'downloads' | 'released_at';

interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

/** Natural first-click direction per column (Bloomberg: biggest first). */
const NATURAL: Record<SortKey, 1 | -1> = {
  ticker: 1,
  prompt_usd_per_mtok: 1,
  context_len: -1,
  elo: -1,
  intelligence_index: -1,
  downloads: -1,
  released_at: -1,
};

/** MKT — full market table, ~750 rows, hand-rolled virtualization. */
export function Mkt({ dispatch }: { dispatch: Dispatch }) {
  const filter = dispatch.args['filter'];
  const [sort, setSort] = useState<Sort>({ key: 'elo', dir: -1 });
  const [scrollTop, setScrollTop] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollPending = useRef(false);
  const latestScrollTop = useRef(0);

  /* rAF-throttled: scroll events fire faster than frames render; the frame
     callback reads the LATEST position so fast flicks land exactly. */
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    latestScrollTop.current = e.currentTarget.scrollTop;
    if (scrollPending.current) return;
    scrollPending.current = true;
    requestAnimationFrame(() => {
      scrollPending.current = false;
      setScrollTop(latestScrollTop.current);
    });
  };

  const state = useEnvelope(`models:${filter ?? 'all'}`, () => api.models(filter), (e) => e.type === 'snapshot');
  const { env } = state;

  const rows = useMemo(() => {
    const data = [...(env?.data ?? [])];
    const { key, dir } = sort;
    data.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === null && bv === null) return a.id.localeCompare(b.id);
      if (av === null) return 1; // nulls always last
      if (bv === null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return dir * String(av).localeCompare(String(bv));
      }
      return dir * (av - bv);
    });
    return data;
  }, [env, sort]);

  const viewportH = bodyRef.current?.clientHeight ?? 600;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(start, end);

  const clickSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: NATURAL[key] }));

  const head = (key: SortKey | null, label: string) => (
    <span
      className={`${styles.headcell} ${sort.key === key ? styles.sorted : ''}`}
      onClick={key ? () => clickSort(key) : undefined}
    >
      {label}
      {sort.key === key ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}
    </span>
  );

  return (
    <Panel
      fn="MKT"
      desc={`market table${filter ? ` · ${filter}` : ''}`}
      meta={env ? `${rows.length} MODELS · AS OF ${fmtTime(env.asOf)}` : undefined}
      stale={env?.stale}
    >
      <div className={styles.root}>
        <div className={styles.toolbar}>
          {(['all', 'open', 'closed'] as const).map((f) => {
            const active = (f === 'all' && !filter) || f === filter;
            return (
              <span
                key={f}
                className={active ? styles.filterActive : styles.filter}
                onClick={() => dispatchFn('MKT', [], f === 'all' ? {} : { filter: f })}
              >
                {f.toUpperCase()}
              </span>
            );
          })}
        </div>
        <div className={styles.headrow}>
          {head('ticker', 'TICKER')}
          {head(null, 'NAME')}
          {head(null, 'OPEN')}
          {head('prompt_usd_per_mtok', 'PROMPT')}
          {head(null, 'COMPL')}
          {head('context_len', 'CTX')}
          {head('elo', 'ELO')}
          {head(null, 'RANK')}
          {head('intelligence_index', 'AA')}
          {head('downloads', 'DL')}
          {head('released_at', 'RELEASED')}
        </div>
        <PanelData state={state} isEmpty={(data) => data.length === 0} emptyText="NO MODELS MATCH">
          {() => (
            <div ref={bodyRef} className={styles.body} onScroll={onScroll}>
              <div style={{ height: start * ROW_H }} />
              {visible.map((m) => (
                <MktRow key={m.id} m={m} />
              ))}
              <div style={{ height: (rows.length - end) * ROW_H }} />
            </div>
          )}
        </PanelData>
      </div>
    </Panel>
  );
}

function MktRow({ m }: { m: MarketRow }) {
  return (
    <div className={styles.row}>
      <span
        className={`${styles.cell} ${common.ticker}`}
        onClick={() => dispatchFn('DES', [entityRef(m.id, m.ticker ?? m.id)])}
      >
        {m.ticker ?? m.id.split('/').pop()?.toUpperCase()}
      </span>
      <span className={`${styles.cell} ${common.white}`} title={m.id}>
        {m.name}
      </span>
      <span className={`${styles.cell} ${m.openness === 'open' ? common.up : common.dim}`}>
        {m.openness === 'open' ? 'OPEN' : 'CLSD'}
      </span>
      <span className={`${styles.cell} ${common.amber}`}>{fmtPrice(m.prompt_usd_per_mtok)}</span>
      <span className={`${styles.cell} ${common.amber}`}>{fmtPrice(m.completion_usd_per_mtok)}</span>
      <span className={`${styles.cell} ${common.white}`}>{m.context_len ? fmtCompact(m.context_len) : '—'}</span>
      <span className={`${styles.cell} ${common.white}`}>{m.elo === null ? '—' : Math.round(m.elo)}</span>
      <span className={`${styles.cell} ${common.dim}`}>{m.arena_rank === null ? '—' : `#${m.arena_rank}`}</span>
      <span className={`${styles.cell} ${common.white}`}>
        {m.intelligence_index === null ? '—' : m.intelligence_index.toFixed(1)}
      </span>
      <span className={`${styles.cell} ${common.white}`}>{m.downloads === null ? '—' : fmtCompact(m.downloads)}</span>
      <span className={`${styles.cell} ${common.dim}`}>{fmtDate(m.released_at)}</span>
    </div>
  );
}