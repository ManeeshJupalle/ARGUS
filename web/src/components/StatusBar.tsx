import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { onSseEvent, onSseState } from '../api/sse';
import { sourceCode } from '../lib/fmt';
import { useArgusStore } from '../store/store';
import styles from './StatusBar.module.css';

const STATUS_POLL_MS = 30_000;
const STATUS_REFRESH_DEBOUNCE_MS = 1_500;

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const date = now
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
    .toUpperCase()
    .replace(/ /g, ' ');
  return `${date}  ${now.toTimeString().slice(0, 8)}`;
}

/** Bottom chrome: per-source health dots, SSE connection state, live clock. */
export function StatusBar() {
  const { statuses, setStatuses, sse, setSse } = useArgusStore();
  const clock = useClock();
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const refresh = () => void api.status().then(setStatuses).catch(() => undefined);
    refresh();
    const poll = window.setInterval(refresh, STATUS_POLL_MS);
    const offEvent = onSseEvent((e) => {
      if (e.type !== 'status') return;
      window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(refresh, STATUS_REFRESH_DEBOUNCE_MS);
    });
    const offState = onSseState(setSse);
    return () => {
      window.clearInterval(poll);
      offEvent();
      offState();
    };
  }, [setStatuses, setSse]);

  const dots = statuses.filter((s) => s.source !== 'heartbeat');
  const sseClass = sse === 'live' ? styles.ok : sse === 'reconnecting' ? styles.stale : styles.fail;

  return (
    <footer className={styles.bar}>
      <span className={styles.brand}>ARGUS</span>
      <div className={styles.sources}>
        {dots.map((s) => {
          const cls =
            s.consecutive_failures > 0 ? styles.fail : s.stale ? styles.stale : styles.ok;
          const title = `${s.source} · last ok ${s.last_success ?? 'never'}${s.last_error ? ` · ${s.last_error}` : ''}`;
          return (
            <span key={s.source} className={styles.source} title={title}>
              <span className={`${styles.dot} ${cls}`}>●</span>
              {sourceCode(s.source)}
            </span>
          );
        })}
      </div>
      <div className={styles.right}>
        <span className={`${styles.sse} ${sseClass}`}>
          {sse === 'live' ? '● SSE LIVE' : sse === 'reconnecting' ? '◌ SSE RECONNECTING' : '○ SSE DOWN'}
        </span>
        <span className={styles.clock}>{clock}</span>
      </div>
    </footer>
  );
}