import { create } from 'zustand';
import type { SourceStatus } from '@argus/shared';
import type { Dispatch } from '../command/parser';
import type { SseState } from '../api/sse';

/**
 * Global terminal state: the active panel dispatch, source health for the
 * status bar, and SSE connection state. Command history lives inside the
 * command line component; panel data lives inside panels.
 */

interface ArgusStore {
  /** Current panel. null = default TOP screen. */
  dispatch: Dispatch | null;
  setDispatch: (d: Dispatch) => void;
  statuses: SourceStatus[];
  setStatuses: (s: SourceStatus[]) => void;
  sse: SseState;
  setSse: (s: SseState) => void;
}

export const useArgusStore = create<ArgusStore>((set) => ({
  dispatch: null,
  setDispatch: (dispatch) => set({ dispatch }),
  statuses: [],
  setStatuses: (statuses) => set({ statuses }),
  sse: 'reconnecting',
  setSse: (sse) => set({ sse }),
}));