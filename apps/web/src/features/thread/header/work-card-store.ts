import { useThreadMeta } from "@ace/client-react";
import { createContext, use, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useLayoutServices, type SessionKey } from "@/lib/layout.tsx";
import { useVisibleParent } from "@/lib/spade-host.ts";
import { createWorkCardTrees, type WorkCardMemory, type WorkCardTrees } from "./work-card-trees.ts";

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
  /** Follow a tree's remembered choice, live, until the returned stop. */
  follow(memory: WorkCardMemory): () => void;
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
 * The room the docked card reserves on the thread area's right: its width plus its edge and
 * its gap to the column. Published as `--work-reserve` (and mirrored to `--summary-inset` so
 * the composer and pills recentre on their existing path) while docked. It is applied inside
 * the scrolled content -- the column settles left by half of it -- never as padding on the
 * area or the scroller, so the scrollbar stays at the area's far right edge.
 */
export const workCardReserve = workCardWidth + 24;

/**
 * Room for the side card beside a reading column that makes room for it: the column narrows
 * from `column` px down to `workCardMinColumn` px, and column + card + gaps must fit the area.
 * A 760px column with the 280px card needs 1088px to stay full; it narrows to 560px at 888px,
 * and below that the card opens as the header's popover instead.
 */
export function workCardFitsSide(areaWidth: number, column: number): boolean {
  const min = Math.min(column, workCardMinColumn);
  return areaWidth >= min + workCardWidth + workCardGaps;
}

/**
 * The reading column's outer width while the card is docked: the full `column` px where it
 * fits beside the card, otherwise whatever is left after the card and its gaps (down to
 * `workCardMinColumn` px; `workCardFitsSide` is false past that). Set as the area's `--column`
 * override, so the transcript and the composer narrow together and stay aligned.
 */
export function workCardColumnWidth(areaWidth: number, column: number): number {
  return Math.min(column, areaWidth - workCardWidth - workCardGaps);
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
  const listeners = new Set<() => void>();
  let button: HTMLButtonElement | null = null;
  let area: HTMLElement | null = null;
  const set = (next: WorkCardState) => {
    if (next.open === state.open && next.side === state.side) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const choose = (open: boolean) => {
    if (open !== wanted) memory?.remember(open);
    wanted = open;
    set({ ...state, open });
  };
  // The choice made elsewhere in the tree: shown where the card docks, never as the popover.
  const sync = (open: boolean) => {
    wanted = open;
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
      sync(next.open());
      const stop = next.subscribe?.(() => sync(next.open()));
      return () => {
        stop?.();
        if (memory === next) memory = undefined;
      };
    },
  };
}

const treesKey: SessionKey<WorkCardTrees> = { name: "workCardTrees" };

/**
 * A thread screen's card store that follows its tree's choice on this device (`work-card-trees`):
 * the main thread, its subagents and its delegates open and close the card together, and moving
 * between them, or to another thread and back, keeps it where the person left it.
 */
export function useTreeWorkCardStore(threadId: string): WorkCardStore {
  const { storage, sessionValue } = useLayoutServices();
  const trees = sessionValue(treesKey, () => createWorkCardTrees(storage));
  const tree = useWorkCardTree(threadId);
  const [store] = useState(() => createWorkCardStore(trees.memory(tree)));
  useLayoutEffect(() => store.follow(trees.memory(tree)), [store, trees, tree]);
  return store;
}

interface Hop {
  /** The parent here, to walk on from. */
  next: string | undefined;
  /** The parent here or on a paired machine: the tree's main thread if nothing is above it. */
  top: string | undefined;
}

function useHop(threadId: string | undefined): Hop {
  const meta = useThreadMeta(threadId);
  const local = useVisibleParent(meta?.delegatedBy);
  return { next: local, top: local ?? meta?.delegatedFrom?.threadId };
}

/**
 * The main thread of `threadId`'s tree: up through the threads that delegated it, three levels
 * at most (deeper chains share the third ancestor's choice). A parent on a paired machine ends
 * the walk; its id names the same thread there. Spade's hidden host is no parent, so a thread
 * Spade delegated is a tree of its own.
 */
export function useWorkCardTree(threadId: string): string {
  const first = useHop(threadId);
  const second = useHop(first.next);
  const third = useHop(second.next);
  return third.top ?? second.top ?? first.top ?? threadId;
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
