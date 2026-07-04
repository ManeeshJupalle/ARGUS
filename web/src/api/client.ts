import type {
  ArenaSeries,
  BenchCompare,
  Envelope,
  Leaderboard,
  MarketRow,
  ModelDetail,
  NewsItem,
  Overview,
  PricePoint,
  SearchResult,
  SourceStatus,
  StatPayload,
  WatchQuote,
} from '@argus/shared';

/**
 * Typed fetch wrappers over the Phase-4/6 API. Response payload types come
 * from @argus/shared — never redeclared here. Non-2xx → thrown Error with the
 * server's {error} message when present (panels render it in-theme).
 */

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string): Promise<Envelope<T>> => req<Envelope<T>>(path);

const SEARCH_CACHE_TTL_MS = 30_000;
const searchCache = new Map<string, { at: number; results: SearchResult[] }>();
const searchInflight = new Map<string, Promise<SearchResult[]>>();

export const api = {
  overview: () => get<Overview>('/api/overview'),
  news: (limit: number, model?: string) =>
    get<NewsItem[]>(`/api/news?limit=${limit}${model ? `&model=${encodeURIComponent(model)}` : ''}`),
  models: (filter?: string) => get<MarketRow[]>(`/api/models${filter ? `?filter=${filter}` : ''}`),
  detail: (id: string) => get<ModelDetail>(`/api/models/${id}`),
  prices: (id: string, range: string) => get<PricePoint[]>(`/api/models/${id}/prices?range=${range}`),
  arenaSeries: (id: string, category: string) =>
    get<ArenaSeries>(`/api/models/${id}/arena?category=${encodeURIComponent(category)}&range=max`),
  leaderboard: (category: string) =>
    get<Leaderboard>(`/api/arena/leaderboard?category=${encodeURIComponent(category)}`),
  compare: (ids: string[]) => get<BenchCompare>(`/api/bench/compare?ids=${ids.join(',')}`),
  stat: () => get<StatPayload>('/api/stat'),
  /**
   * Entity search with a short-lived cache + in-flight dedupe: ghost-text
   * autocomplete and Enter-time resolution hit the same prefix back to back,
   * so the second call must not pay a network round trip.
   */
  search: async (q: string): Promise<SearchResult[]> => {
    const key = q.trim().toLowerCase();
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.results;
    let p = searchInflight.get(key);
    if (!p) {
      p = get<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`).then((res) => res.data);
      searchInflight.set(key, p);
      void p.finally(() => searchInflight.delete(key));
    }
    const results = await p;
    searchCache.set(key, { at: Date.now(), results });
    if (searchCache.size > 200) {
      const oldest = searchCache.keys().next().value;
      if (oldest !== undefined) searchCache.delete(oldest);
    }
    return results;
  },
  watchlist: () => get<WatchQuote[]>('/api/watchlist'),
  watchAdd: (model_id: string) =>
    req<{ ok: boolean }>('/api/watchlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_id }),
    }),
  watchRemove: (model_id: string) => req<{ ok: boolean }>(`/api/watchlist/${model_id}`, { method: 'DELETE' }),
  /** /api/status is bare (Phase-1 shape + stale), not enveloped. */
  status: async (): Promise<SourceStatus[]> => req<SourceStatus[]>('/api/status'),
};