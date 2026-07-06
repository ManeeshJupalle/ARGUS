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
 *
 * Browser history integration: every panel/layout change pushes a history
 * entry carrying the serialized layout, and popstate restores it — so
 * Back/Forward walk the command trail instead of leaving the app.
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

function serialize(state: Pick<ArgusStore, 'layout' | 'focused' | 'panels'>): StoredLayout {
  return {
    layout: state.layout,
    focused: state.focused,
    panels: state.panels.map((p) =>
      p ? { fn: p.spec.fn, entities: p.entities, args: p.args } : null,
    ),
  };
}

/** Stored → live state; unknown fns (registry drift) become empty slots. */
function hydrate(stored: StoredLayout): Pick<ArgusStore, 'layout' | 'focused' | 'panels'> {
  const panels = Array.from({ length: SLOTS }, (_, i) => {
    const p = stored.panels[i];
    if (!p) return null;
    const spec = findCommand(p.fn);
    return spec ? { spec, entities: p.entities, args: p.args } : null;
  });
  return { layout: stored.layout, focused: Math.min(stored.focused, stored.layout - 1), panels };
}

function load(): Pick<ArgusStore, 'layout' | 'focused' | 'panels'> {
  const fallback = { layout: 1 as LayoutPreset, focused: 0, panels: Array<Dispatch | null>(SLOTS).fill(null) };
  try {
    // The saved workspace survives reloads (F5) and history re-entries only.
    // A fresh URL entry is a new session: land on the home screen (TOP).
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const navType = nav?.type ?? 'navigate';
    if (navType !== 'reload' && navType !== 'back_forward') {
      persist(fallback);
      return fallback;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as StoredLayout;
    if (![1, 2, 4].includes(stored.layout)) return fallback;
    return hydrate(stored);
  } catch {
    return fallback;
  }
}

function persist(state: Pick<ArgusStore, 'layout' | 'focused' | 'panels'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(state)));
  } catch {
    /* storage full/blocked: layout just won't survive reload */
  }
}

/* ---- browser history ---- */

let restoringFromHistory = false;

/** Push a history entry for a navigation (panel/layout change), deduped. */
function pushHistory(state: Pick<ArgusStore, 'layout' | 'focused' | 'panels'>): void {
  if (restoringFromHistory) return;
  const snapshot = serialize(state);
  if (JSON.stringify(window.history.state) === JSON.stringify(snapshot)) return;
  window.history.pushState(snapshot, '');
}

let historyInitialized = false;

/**
 * Called once from the Shell: seeds the current entry with the boot state
 * and restores terminal state when the user navigates Back/Forward.
 */
export function initHistory(): void {
  if (historyInitialized) return;
  historyInitialized = true;
  window.history.replaceState(serialize(useArgusStore.getState()), '');
  window.addEventListener('popstate', (e: PopStateEvent) => {
    const stored = e.state as StoredLayout | null;
    if (!stored || !Array.isArray(stored.panels)) return;
    restoringFromHistory = true;
    const hydrated = hydrate(stored);
    useArgusStore.setState(hydrated);
    persist(hydrated);
    restoringFromHistory = false;
  });
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
      pushHistory(get());
      return;
    }
    set((s) => ({ panels: s.panels.map((p, i) => (i === s.focused ? d : p)) }));
    persist(get());
    pushHistory(get());
  },

  setLayout: (layout) =>
    set((s) => {
      const next = { ...s, layout, focused: Math.min(s.focused, layout - 1) };
      persist(next);
      pushHistory(next);
      return { layout, focused: next.focused };
    }),

  focusPanel: (i) =>
    set((s) => {
      if (i < 0 || i >= s.layout) return {};
      const next = { ...s, focused: i };
      persist(next); // focus is not a navigation: persisted, but no history entry
      return { focused: i };
    }),

  setPrefill: (prefill) => set({ prefill }),
  setStatuses: (statuses) => set({ statuses }),
  setSse: (sse) => set({ sse }),
}));