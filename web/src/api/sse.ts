import type { SseEvent } from '@argus/shared';

/**
 * /api/stream subscription with liveness watchdog. EventSource auto-reconnects
 * on clean breaks, but proxies can hold a client connection open after the
 * upstream dies (observed with the Vite dev proxy) — so the server beats a
 * `ping` event every ~25s and the client force-reconnects after two missed
 * beats. Panels refetch on every 'live' transition (missed events are never
 * replayed).
 */

export type SseState = 'live' | 'reconnecting' | 'down';

type EventListener = (event: SseEvent) => void;
type StateListener = (state: SseState) => void;

const KEEPALIVE_TIMEOUT_MS = 65_000; // server pings every 25s; 2 misses = dead
const WATCHDOG_INTERVAL_MS = 10_000;

const eventListeners = new Set<EventListener>();
const stateListeners = new Set<StateListener>();
let source: EventSource | null = null;
let started = false;
let lastBeat = 0;

function emitState(state: SseState): void {
  for (const cb of stateListeners) cb(state);
}

// DOM's addEventListener wants (Event) => void; our handler reads .data only.
type DomListener = (e: Event) => void;

function handleMessage(raw: MessageEvent<string>): void {
  const event = JSON.parse(raw.data) as SseEvent;
  for (const cb of eventListeners) cb(event);
}

function connect(): void {
  source = new EventSource('/api/stream');
  lastBeat = Date.now();
  source.onopen = () => {
    lastBeat = Date.now();
    emitState('live');
  };
  source.onerror = () => {
    emitState(source && source.readyState === EventSource.CLOSED ? 'down' : 'reconnecting');
  };
  source.addEventListener('ping', () => {
    lastBeat = Date.now();
  });
  for (const type of ['snapshot', 'news', 'status'] as const) {
    source.addEventListener(type, ((e: MessageEvent<string>) => {
      lastBeat = Date.now();
      handleMessage(e);
    }) as DomListener);
  }
}

export function connectSse(): void {
  if (started) return;
  started = true;
  connect();
  window.setInterval(() => {
    if (Date.now() - lastBeat <= KEEPALIVE_TIMEOUT_MS) return;
    source?.close();
    emitState('reconnecting');
    connect(); // resets lastBeat: each attempt gets a full timeout window
  }, WATCHDOG_INTERVAL_MS);
}

export function onSseEvent(cb: EventListener): () => void {
  eventListeners.add(cb);
  return () => eventListeners.delete(cb);
}

export function onSseState(cb: StateListener): () => void {
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
}