import { findCommand } from '@argus/shared';
import type { CommandSpec, SearchResult } from '@argus/shared';
import { useArgusStore } from '../store/store';

/** Programmatic dispatch for clickable function codes (blue = typeable AND clickable). */
export function dispatchFn(
  fn: string,
  entities: SearchResult[] = [],
  args: Record<string, string> = {},
): void {
  const spec = findCommand(fn) as CommandSpec;
  void useArgusStore.getState().execute({ spec, entities, args });
}

/** Minimal SearchResult for a known model (id + display code). */
export function entityRef(id: string, code: string): SearchResult {
  return { id, ticker: code, name: code, via: 'id', score: 100 };
}

/** Put text into the command line (e.g. DES's BENCH code needs a second entity). */
export function prefillCommand(text: string): void {
  useArgusStore.getState().setPrefill(text);
}