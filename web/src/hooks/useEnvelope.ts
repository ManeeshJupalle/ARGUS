import { useCallback, useEffect, useRef, useState } from 'react';
import type { Envelope, SseEvent } from '@argus/shared';
import { onSseEvent, onSseState } from '../api/sse';

const REFETCH_DEBOUNCE_MS = 400;

export interface EnvelopeState<T> {
  env: Envelope<T> | null;
  /** Last load error; previously loaded data is kept alongside it. */
  error: string | null;
  loading: boolean;
  /** Manual reload — the RETRY affordance on error states. */
  retry: () => void;
}

/**
 * Standard panel data lifecycle: load on mount, debounced refetch on matching
 * SSE events, resync on every SSE 'live' transition (missed events are never
 * replayed), and a manual retry for API-down states.
 */
export function useEnvelope<T>(
  load: () => Promise<Envelope<T>>,
  deps: unknown[],
  refetchOn: (e: SseEvent) => boolean,
): EnvelopeState<T> {
  const [state, setState] = useState<Omit<EnvelopeState<T>, 'retry'>>({
    env: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const debounce = useRef<number | undefined>(undefined);
  const retry = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const run = () =>
      void load()
        .then((env) => alive && setState({ env, error: null, loading: false }))
        .catch(
          (err: unknown) =>
            alive &&
            setState((s) => ({
              env: s.env,
              error: err instanceof Error ? err.message : String(err),
              loading: false,
            })),
        );
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
  }, [...deps, tick]);

  return { ...state, retry };
}