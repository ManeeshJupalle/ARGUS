import { create } from 'zustand';
import { findCommand } from '@argus/shared';
import type { SearchResult, SourceStatus } from '@argus/shared';
import { api } from '../api/client';
import type { Dispatch } from '../command/parser';
import type { SseState } from '../api/sse';

/**
 * Global terminal state. PHASE-6: up to four panel slots (LAYOUT 1/2/4),
 * a focused slot that commands execute into, and localStorage persistence
 * of the layout + panel dispatches across reloads.
 */

export type LayoutPreset = 1 | 2 | 4;
const SLOTS = 4;
const STORAGE_KEY = 'argus.layout.v1';

interface ArgusStore {
  layout: LayoutPreset;
  /** Dispatches per slot; null = empty slot (slot 0 defaults to TOP). */
  panels: (Dispatch | null)[];
  focused: number;
  /** Pending command-line prefill (e.g. DES's BENCH code). */
  prefill: string | null;
  statuses: SourceStatus[];
  sse: SseState;

  /** Route a parsed command: LAYOUT/WATCH-mutations act, others fill the focused panel. */
  execute: (d: Dispatch) => Promise<void>;
  setLayout: (p: LayoutPreset) => void;
  focusPanel: (i: number) => void;
  setPrefill: (v: string | null) => void;
  setStatuses: (s: SourceStatus[]) => void;
  setSse: (s: SseState) => void;
  /** Bumped after WATCH ADD/RM so mounted Watch panels refetch. */
  watchVersion: number;
}

/* ---- persistence (layout + dispatch skeletons; entities are small) ---- */

interface StoredDispatch {
  fn: string;
  entities: SearchResult[];
  args: Record<string, string>;
}

interface StoredLayout {
  layout: LayoutPreset;
  focused: number;
  panels: (StoredDispatch | null)[];
}

function load(): Pick<ArgusStore, 'layout' | 'focused' | 'panels'> {
  const fallback = { layout: 1 as LayoutPreset, focused: 0, panels: Array<Dispatch | null>(SLOTS).fill(null) };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as StoredLayout;
    if (![1, 2, 4].includes(stored.layout)) return fallback;
    const panels = Array.from({ length: SLOTS }, (_, i) => {
      const p = stored.panels[i];
      if (!p) return null;
      const spec = findCommand(p.fn);
      return spec ? { spec, entities: p.entities, args: p.args } : null;
    });
    return { layout: stored.layout, focused: Math.min(stored.focused, stored.layout - 1), panels };
  } catch {
    return fallback;
  }
}

function persist(state: ArgusStore): void {
  const stored: StoredLayout = {
    layout: state.layout,
    focused: state.focused,
    panels: state.panels.map((p) =>
      p ? { fn: p.spec.fn, entities: p.entities, args: p.args } : null,
    ),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* storage full/blocked: layout just won't survive reload */
  }
}

export const useArgusStore = create<ArgusStore>((set, get) => ({
  ...load(),
  prefill: null,
  statuses: [],
  sse: 'reconnecting',
  watchVersion: 0,

  execute: async (d) => {
    if (d.spec.fn === 'LAYOUT') {
      get().setLayout(Number(d.args['preset']) as LayoutPreset);
      return;
    }
    if (d.spec.fn === 'WATCH' && d.args['action'] !== undefined) {
      const target = d.entities[0];
      if (target) {
        if (d.args['action'] === 'ADD') await api.watchAdd(target.id);
        else await api.watchRemove(target.id);
      }
      set((s) => ({ watchVersion: s.watchVersion + 1 }));
      // Fall through: show the board after a mutation.
      const bare: Dispatch = { spec: d.spec, entities: [], args: {} };
      set((s) => ({ panels: s.panels.map((p, i) => (i === s.focused ? bare : p)) }));
      persist(get());
      return;
    }
    set((s) => ({ panels: s.panels.map((p, i) => (i === s.focused ? d : p)) }));
    persist(get());
  },

  setLayout: (layout) =>
    set((s) => {
      const next = { ...s, layout, focused: Math.min(s.focused, layout - 1) };
      persist(next as ArgusStore);
      return { layout, focused: next.focused };
    }),

  focusPanel: (i) =>
    set((s) => {
      if (i < 0 || i >= s.layout) return {};
      const next = { ...s, focused: i };
      persist(next as ArgusStore);
      return { focused: i };
    }),

  setPrefill: (prefill) => set({ prefill }),
  setStatuses: (statuses) => set({ statuses }),
  setSse: (sse) => set({ sse }),
}));