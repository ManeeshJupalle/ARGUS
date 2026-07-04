import { useRef } from 'react';
import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { NewsList } from '../components/NewsList';
import { Panel } from '../components/Panel';
import { useEnvelope } from '../hooks/useEnvelope';
import { useTickerMap } from '../hooks/useTickerMap';
import { fmtTime } from '../lib/fmt';
import common from './common.module.css';

const LIMIT = 100;

/** NEWS — dense feed, optionally filtered to one model via model_ids. */
export function News({ dispatch }: { dispatch: Dispatch }) {
  const entity = dispatch.entities[0];
  const tickers = useTickerMap();
  const known = useRef<Set<string>>(new Set());
  const fresh = useRef<Set<string>>(new Set());

  const { env, error, loading } = useEnvelope(
    async () => {
      const res = await api.news(LIMIT, entity?.id);
      const incoming = new Set(res.data.map((n) => n.id));
      fresh.current = new Set([...incoming].filter((id) => known.current.size > 0 && !known.current.has(id)));
      known.current = incoming;
      return res;
    },
    [entity?.id],
    (e) => e.type === 'news',
  );

  const items = env?.data ?? [];
  const desc = entity ? `news · ${entity.ticker ?? entity.id.toUpperCase()}` : 'news feed';

  return (
    <Panel fn="NEWS" desc={desc} meta={env ? `AS OF ${fmtTime(env.asOf)}` : undefined} stale={env?.stale}>
      {loading ? (
        <div className={common.note}>LOADING…</div>
      ) : error ? (
        <div className={common.error}>API ERROR — {error}</div>
      ) : items.length === 0 ? (
        <div className={common.note}>NO NEWS{entity ? ` LINKED TO ${entity.ticker ?? entity.id.toUpperCase()}` : ''}</div>
      ) : (
        <NewsList items={items} fresh={fresh.current} tickers={tickers} />
      )}
    </Panel>
  );
}