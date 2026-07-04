import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { CommandHistory } from '../command/history';
import { executeCommand, suggest, tokenize, type CommandError } from '../command/parser';
import { findCommand } from '@argus/shared';
import { useArgusStore } from '../store/store';
import styles from './CommandLine.module.css';

const GO_FLASH_MS = 600;
const ENTITY_GHOST_DEBOUNCE_MS = 150;

/**
 * The §7/§8 signature element. Grammar errors render inline, in red, in the
 * bar itself — never a modal. Enter flashes a green ‹GO› chip.
 */
export function CommandLine() {
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef(new CommandHistory());
  const [value, setValue] = useState('');
  const [ghost, setGhost] = useState<string | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [go, setGo] = useState(false);
  const execute = useArgusStore((s) => s.execute);
  const prefill = useArgusStore((s) => s.prefill);
  const setPrefill = useArgusStore((s) => s.setPrefill);

  /* Panels can push a partial command here (e.g. DES's BENCH code). */
  useEffect(() => {
    if (prefill === null) return;
    setValue(prefill);
    setError(null);
    setGhost(null);
    setPrefill(null);
    inputRef.current?.focus();
  }, [prefill, setPrefill]);

  /* Focus from anywhere: '/' or Ctrl+K. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Ghost text: registry statics first, async entity ticker as fallback. */
  const entityGhostTimer = useRef<number | undefined>(undefined);
  const refreshGhost = useCallback((next: string) => {
    window.clearTimeout(entityGhostTimer.current);
    const staticGhost = suggest(next);
    if (staticGhost !== null) {
      setGhost(staticGhost);
      return;
    }
    setGhost(null);
    // Entity ghost applies while typing the first token only (entity-first form).
    const tokens = tokenize(next);
    if (tokens.length !== 1 || /\s$/.test(next) || findCommand(tokens[0] as string)) return;
    const query = tokens[0] as string;
    entityGhostTimer.current = window.setTimeout(() => {
      void api
        .search(query)
        .then((results) => {
          const ticker = results[0]?.ticker;
          if (!ticker) return;
          if (
            ticker.toUpperCase().startsWith(query.toUpperCase()) &&
            ticker.length > query.length &&
            inputRef.current?.value === next
          ) {
            setGhost(ticker.slice(query.length));
          }
        })
        .catch(() => undefined); // ghost text silently disappears when the API is down
    }, ENTITY_GHOST_DEBOUNCE_MS);
  }, []);

  const onChange = (next: string) => {
    setValue(next);
    setError(null);
    historyRef.current.reset();
    refreshGhost(next);
  };

  const run = async () => {
    const input = value;
    const result = await executeCommand(input, api.search);
    if ('code' in result) {
      if (result.code === 'EMPTY') return;
      setError(result);
      return;
    }
    try {
      await execute(result); // WATCH ADD/RM hit the write API and can fail
    } catch (err) {
      setError({
        code: 'BAD_ARGS',
        message: `${result.spec.fn} FAILED — ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    historyRef.current.push(input);
    setValue('');
    setGhost(null);
    setError(null);
    setGo(true);
    window.setTimeout(() => setGo(false), GO_FLASH_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
    } else if (e.key === 'Tab') {
      if (ghost) {
        e.preventDefault();
        onChange(value + ghost);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const entry = historyRef.current.prev();
      if (entry !== null) {
        setValue(entry);
        setGhost(null);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const entry = historyRef.current.next();
      setValue(entry ?? '');
      setGhost(null);
    } else if (e.key === 'Escape') {
      setValue('');
      setGhost(null);
      setError(null);
      historyRef.current.reset();
    }
  };

  return (
    <div className={styles.bar}>
      <span className={styles.accent} />
      <span className={styles.prompt}>ARGUS</span>
      <div className={styles.inputwrap}>
        <div className={styles.ghostline} aria-hidden="true">
          <span className={styles.mirror}>{value}</span>
          <span className={styles.ghost}>{ghost ?? ''}</span>
        </div>
        <input
          ref={inputRef}
          className={styles.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label="command line"
          placeholder=""
        />
      </div>
      {go ? <span className={styles.go}>‹GO›</span> : null}
      {error ? <span className={styles.error}>{error.message}</span> : null}
      {!go && !error ? (
        <span className={styles.hint}>TAB AUTOCOMPLETE · ↑ HISTORY · HELP ‹GO›</span>
      ) : null}
    </div>
  );
}