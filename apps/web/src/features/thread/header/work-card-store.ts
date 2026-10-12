import { createContext, use, useSyncExternalStore } from "react";

/*
 * Whether the thread's Work card is open, and where it fits. The header's Work icon and the
 * thread area's side slot share it, so toggling the card never re-renders the transcript.
 */

export interface WorkCardState {
  open: boolean;
  /** The thread area has room for the card beside the reading column. */
  side: boolean;
}

export interface WorkCardStore {
  get(): WorkCardState;
  subscribe(listener: () => void): () => void;
  setOpen(open: boolean): void;
  toggle(): void;
  setSide(side: boolean): void;
}

/** The card's width and the gap it keeps from the reading column and the area's edge. */
export const workCardWidth = 280;
const gutter = 32;

/**
 * Room for the side card: the centred reading column (`column` px at most, 48px of padding on
 * a narrow area) leaves a gutter at least as wide as the card plus its margins.
 */
export function workCardFitsSide(areaWidth: number, column: number): boolean {
  const shown = Math.min(column, areaWidth - 48);
  return (areaWidth - shown) / 2 >= workCardWidth + gutter;
}

export function createWorkCardStore(): WorkCardStore {
  let state: WorkCardState = { open: false, side: false };
  const listeners = new Set<() => void>();
  const set = (next: WorkCardState) => {
    if (next.open === state.open && next.side === state.side) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOpen: (open) => set({ ...state, open }),
    toggle: () => set({ ...state, open: !state.open }),
    // The side card stays until closed on purpose; one that no longer fits closes rather than
    // jumping into the header's popover.
    setSide: (side) => set({ open: state.open && (side || !state.side), side }),
  };
}

export const WorkCardContext = createContext<WorkCardStore | null>(null);

/** The thread screen's Work card store; undefined outside a thread screen. */
export function useWorkCardStore(): WorkCardStore | null {
  return use(WorkCardContext);
}

const closed: WorkCardState = { open: false, side: false };
const noop = () => () => {};

export function useWorkCardState(store: WorkCardStore | null): WorkCardState {
  return useSyncExternalStore(
    store ? store.subscribe : noop,
    store ? store.get : () => closed,
    () => closed,
  );
}
