import type { Envelope, NewsItem, Overview, SearchResult, SourceStatus } from '@argus/shared';

/**
 * Typed fetch wrappers over the Phase-4 read API. Response payload types come
 * from @argus/shared — never redeclared here.
 */

async function get<T>(path: string): Promise<Envelope<T>> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as Envelope<T>;
}

export const api = {
  overview: () => get<Overview>('/api/overview'),
  news: (limit: number) => get<NewsItem[]>(`/api/news?limit=${limit}`),
  search: async (q: string): Promise<SearchResult[]> => {
    const res = await get<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`);
    return res.data;
  },
  /** /api/status is bare (Phase-1 shape + stale), not enveloped. */
  status: async (): Promise<SourceStatus[]> => {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`/api/status → HTTP ${res.status}`);
    return (await res.json()) as SourceStatus[];
  },
};