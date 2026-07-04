import { useEffect, useState } from 'react';
import type { Envelope } from '@argus/shared';

/** id → display code for model links (fetched once per mount; tickers win). */
export function useTickerMap(): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    void fetch('/api/models')
      .then((r) => r.json())
      .then((body: Envelope<{ id: string; ticker: string | null }[]>) => {
        setMap(
          new Map(body.data.map((m) => [m.id, m.ticker ?? m.id.split('/').pop()?.toUpperCase() ?? m.id])),
        );
      })
      .catch(() => undefined);
  }, []);
  return map;
}