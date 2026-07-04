import type { ReactNode } from 'react';
import type { EnvelopeState } from '../hooks/useEnvelope';
import common from '../panels/common.module.css';

/**
 * PHASE-7 state audit: one shape for every panel's data lifecycle.
 * - no data yet + loading  → LOADING…
 * - no data + failed       → in-theme API notice with RETRY (never blank)
 * - data + failed refresh  → red banner above the (kept) last data
 * - data + empty           → panel-specific empty text
 */
export function PanelData<T>({
  state,
  isEmpty,
  emptyText,
  children,
}: {
  state: EnvelopeState<T>;
  isEmpty?: (data: T) => boolean;
  emptyText?: string;
  children: (data: T) => ReactNode;
}) {
  const { env, error, loading, retry } = state;
  if (!env) {
    if (loading && !error) return <div className={common.note}>LOADING…</div>;
    return (
      <div className={common.error}>
        API UNREACHABLE — {error ?? 'NO RESPONSE'}{' '}
        <span className={common.code} onClick={retry}>
          RETRY
        </span>
      </div>
    );
  }
  return (
    <>
      {error ? (
        <div className={common.error}>
          REFRESH FAILED — {error} · SHOWING LAST DATA{' '}
          <span className={common.code} onClick={retry}>
            RETRY
          </span>
        </div>
      ) : null}
      {(isEmpty?.(env.data) ?? false) ? (
        <div className={common.note}>{emptyText ?? 'NO DATA'}</div>
      ) : (
        children(env.data)
      )}
    </>
  );
}