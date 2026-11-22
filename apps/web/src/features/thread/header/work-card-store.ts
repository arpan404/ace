import { createContext, use, useSyncExternalStore } from "react";
import type { WorkCardMemory } from "./work-card-trees.ts";

/*
 * Whether the thread's Work card is open, and where it fits. The header's details icon and the
 * thread area's side slot share it, so toggling the card never re-renders the transcript.
 */

export interface WorkCardState {
  open: boolean;
  /** The thread area has room for the card beside the reading column. */
  side: boolean;
}

export interface WorkCardStore {
  /** The header's details icon: the popover's anchor, and where focus returns on close. */
  button(): HTMLButtonElement | null;
  attachButton(button: HTMLButtonElement | null): void;
  /** The thread area the card measures and floats in; it holds the composer too. */
  area(): HTMLElement | null;
  attachArea(area: HTMLElement | null): void;
  get(): WorkCardState;
  subscribe(listener: () => void): () => void;
  setOpen(open: boolean): void;
  toggle(): void;
  setSide(side: boolean): void;
  /**
   * Follow a tree's remembered choice, live, until the returned stop. A choice the person made
   * while the store followed no tree is saved to this one instead.
   */
  follow(memory: WorkCardMemory): () => void;
  /**
   * Whether the card should take focus as it shows: only once after the person opened it. A card
   * that shows because it was remembered, or opened on another screen, leaves focus where it is.
   */
  takeFocus(): boolean;
}

/** The card's width, from the floating surface both placements share. */
export const workCardWidth = 280;
/**
 * The reading column's narrowest while the card is docked beside it: 560px outer, 528px of
 * prose with the docked 16px sides. Between the 480px wizards and the 640px settings floor,
 * still a comfortable line length at the default 15px transcript size.
 */
export const workCardMinColumn = 560;
/**
 * What the docked column and card need past their own widths, all on the 4px grid: 12px from
 * the card to the area's edge (its `right-3`), 12px between the column and the card
 * (`--surface-inset`), and 24px of breathing on the column's left.
 */
export const workCardGaps = 48;
/**
 * Room for the side card: it floats over the column's edge, never moving it, once the area holds
 * the narrowest comfortable column (`workCardMinColumn`) with the card and its gaps. Below that
 * the card opens as the header's popover instead.
 */
export function workCardFitsSide(areaWidth: number, column: number): boolean {
  const min = Math.min(column, workCardMinColumn);
  return areaWidth >= min + workCardWidth + workCardGaps;
}

/**
 * The card a thread screen starts with. Only the person's own open or close is remembered: a
 * card left open docks again whenever the area has room beside the column, on this screen or
 * another of the tree. A docked card squeezed out by a narrow area closes rather than jumping
 * into the header's popover, and comes back when the room does; a remembered card never comes
 * back as the popover, which would cover the transcript on its own.
 */
export function createWorkCardStore(initial?: WorkCardMemory): WorkCardStore {
  let state: WorkCardState = { open: false, side: false };
  let memory = initial;
  let wanted = memory?.open() ?? false;
  /** The person chose while no tree was followed; the next tree followed takes the choice. */
  let unsaved = false;
  let focus = false;
  const listeners = new Set<() => void>();
  let button: HTMLButtonElement | null = null;
  let area: HTMLElement | null = null;
  const set = (next: WorkCardState) => {
    if (next.open === state.open && next.side === state.side) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const choose = (open: boolean) => {
    if (!memory) unsaved = true;
    else if (open !== wanted) memory.remember(open);
    wanted = open;
    focus = open;
    set({ ...state, open });
  };
  // The choice made elsewhere in the tree: shown where the card docks, never as the popover.
  const sync = (open: boolean) => {
    wanted = open;
    focus = false;
    if (state.side || !open) set({ ...state, open });
  };
  return {
    button: () => button,
    attachButton: (next) => {
      button = next;
    },
    area: () => area,
    attachArea: (next) => {
      area = next;
    },
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOpen: choose,
    toggle: () => choose(!state.open),
    // Room decides where the card shows, never whether the person wants it: a layout change
    // (a side panel opening, a window resize) is not a close.
    setSide: (side) => {
      const open = side ? state.open || wanted : state.open && !state.side;
      set({ open, side });
    },
    follow(next) {
      memory = next;
      if (unsaved) {
        unsaved = false;
        next.remember(wanted);
      } else sync(next.open());
      const stop = next.subscribe?.(() => sync(next.open()));
      return () => {
        stop?.();
        if (memory === next) memory = undefined;
      };
    },
    takeFocus() {
      const take = focus && state.open;
      focus = false;
      return take;
    },
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
