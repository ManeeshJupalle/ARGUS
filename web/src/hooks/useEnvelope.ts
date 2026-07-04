import { useEffect, useRef, useState } from 'react';
import type { Envelope, SseEvent } from '@argus/shared';
import { onSseEvent, onSseState } from '../api/sse';

const REFETCH_DEBOUNCE_MS = 400;

export interface EnvelopeState<T> {
  env: Envelope<T> | null;
  /** Last load error; kept alongside any previously loaded data. */
  error: string | null;
  loading: boolean;
}

/**
 * Standard panel data lifecycle: load on mount, debounced refetch on matching
 * SSE events, and resync on every SSE 'live' transition (missed events are
 * never replayed — same semantics as TOP since Phase 5).
 */
export function useEnvelope<T>(
  load: () => Promise<Envelope<T>>,
  deps: unknown[],
  refetchOn: (e: SseEvent) => boolean,
): EnvelopeState<T> {
  const [state, setState] = useState<EnvelopeState<T>>({ env: null, error: null, loading: true });
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setState({ env: null, error: null, loading: true });
    const run = () =>
      void load()
        .then((env) => alive && setState({ env, error: null, loading: false }))
        .catch((err: unknown) =>
          alive &&
          setState((s) => ({ env: s.env, error: err instanceof Error ? err.message : String(err), loading: false })),
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
  }, deps);

  return state;
}