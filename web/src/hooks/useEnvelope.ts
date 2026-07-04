import { useCallback, useEffect, useRef, useState } from 'react';
import type { Envelope, SseEvent } from '@argus/shared';
import { onSseEvent, onSseState } from '../api/sse';

const REFETCH_DEBOUNCE_MS = 400;
const CACHE_MAX_ENTRIES = 100;

/**
 * Stale-while-revalidate cache shared by every panel: switching panels (or
 * re-running a command) renders the last known envelope instantly and
 * refreshes in the background — no LOADING flash for anything seen before.
 * In-flight dedupe means concurrent mounts of the same key (StrictMode,
 * multi-panel layouts) share one request.
 */
const envCache = new Map<string, Envelope<unknown>>();
const inflight = new Map<string, Promise<Envelope<unknown>>>();

function remember(key: string, env: Envelope<unknown>): void {
  envCache.delete(key); // re-insert to keep Map iteration order ≈ LRU
  envCache.set(key, env);
  if (envCache.size > CACHE_MAX_ENTRIES) {
    const oldest = envCache.keys().next().value;
    if (oldest !== undefined) envCache.delete(oldest);
  }
}

export interface EnvelopeState<T> {
  env: Envelope<T> | null;
  /** Last load error; previously loaded data is kept alongside it. */
  error: string | null;
  loading: boolean;
  /** Manual reload — the RETRY affordance on error states. */
  retry: () => void;
}

/**
 * Standard panel data lifecycle: cached render + background load on mount,
 * debounced refetch on matching SSE events, resync on every SSE 'live'
 * transition (missed events are never replayed), manual retry for API-down.
 * `key` uniquely identifies the request (endpoint + params).
 */
export function useEnvelope<T>(
  key: string,
  load: () => Promise<Envelope<T>>,
  refetchOn: (e: SseEvent) => boolean,
): EnvelopeState<T> {
  const [state, setState] = useState<Omit<EnvelopeState<T>, 'retry'>>(() => {
    const cached = envCache.get(key) as Envelope<T> | undefined;
    return { env: cached ?? null, error: null, loading: !cached };
  });
  const [tick, setTick] = useState(0);
  const debounce = useRef<number | undefined>(undefined);
  const retry = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    // Key switch: show that key's cache instantly (or LOADING), never the
    // previous key's data.
    const cached = envCache.get(key) as Envelope<T> | undefined;
    setState({ env: cached ?? null, error: null, loading: true });

    const run = () => {
      let p = inflight.get(key) as Promise<Envelope<T>> | undefined;
      if (!p) {
        p = load();
        inflight.set(key, p as Promise<Envelope<unknown>>);
        void p.finally(() => inflight.delete(key));
      }
      p.then((env) => {
        remember(key, env);
        if (alive) setState({ env, error: null, loading: false });
      }).catch((err: unknown) => {
        if (alive)
          setState((s) => ({
            env: s.env,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          }));
      });
    };
    const schedule = () => {
      window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(run, REFETCH_DEBOUNCE_MS);
    };
    run();
    const offEvent = onSseEvent((e) => refetchOn(e) && schedule());
    const offState = onSseState((s) => s === 'live' && schedule());
    return () => {
      alive = false;
      window.clearTimeout(debounce.current);
      offEvent();
      offState();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  return { ...state, retry };
}