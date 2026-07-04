import { useRef } from 'react';
import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import { NewsList } from '../components/NewsList';
import { Panel } from '../components/Panel';
import { PanelData } from '../components/PanelData';
import { useEnvelope } from '../hooks/useEnvelope';
import { useTickerMap } from '../hooks/useTickerMap';
import { fmtTime } from '../lib/fmt';

const LIMIT = 100;

/** NEWS — dense feed, optionally filtered to one model via model_ids. */
export function News({ dispatch }: { dispatch: Dispatch }) {
  const entity = dispatch.entities[0];
  const tickers = useTickerMap();
  const known = useRef<Set<string>>(new Set());
  const fresh = useRef<Set<string>>(new Set());

  const state = useEnvelope(
    `news:${entity?.id ?? 'all'}`,
    async () => {
      const res = await api.news(LIMIT, entity?.id);
      const incoming = new Set(res.data.map((n) => n.id));
      fresh.current = new Set([...incoming].filter((id) => known.current.size > 0 && !known.current.has(id)));
      known.current = incoming;
      return res;
    },
    (e) => e.type === 'news',
  );

  const { env } = state;
  const desc = entity ? `news · ${entity.ticker ?? entity.id.toUpperCase()}` : 'news feed';

  return (
    <Panel fn="NEWS" desc={desc} meta={env ? `AS OF ${fmtTime(env.asOf)}` : undefined} stale={env?.stale}>
      <PanelData
        state={state}
        isEmpty={(items) => items.length === 0}
        emptyText={`NO NEWS${entity ? ` LINKED TO ${entity.ticker ?? entity.id.toUpperCase()}` : ''}`}
      >
        {(items) => <NewsList items={items} fresh={fresh.current} tickers={tickers} />}
      </PanelData>
    </Panel>
  );
}