import {
  listedSelection,
  noSelection,
  selectRange,
  toggleSelected,
  type ListSelection,
} from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import { perWindow } from "@/lib/per-window.ts";

/**
 * A bulk action waiting on the person's yes: the selection bar's dialog asks. Only Delete,
 * which can't be undone; Archive goes at once, with Undo.
 */
export type BulkConfirm = "delete";

interface State extends ListSelection {
  confirm: BulkConfirm | undefined;
  rename: { id: string; title: string } | undefined;
}

/**
 * The Home threads picked for a bulk action, one per window, so the list, its selection bar and
 * the palette share it. Ids are the list's row ids: another machine's thread is picked and
 * renamed under its machine row id (`machine:[hostId,threadId]`, ADR 0102), so it never stands
 * for a thread of this window's daemon with the same id.
 */
export class HomeSelection {
  private state: State = { ...noSelection, confirm: undefined, rename: undefined };
  private listeners = new Set<() => void>();
  getState = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  rename(id: string, title: string): void {
    this.set({ rename: { id, title } });
  }
  finishRename(): void {
    this.set({ rename: undefined });
  }
  toggle(id: string): void {
    this.set(toggleSelected(this.state, id));
  }
  range(order: readonly string[], id: string): void {
    this.set(selectRange(this.state, order, id));
  }
  /** Drop picked threads no longer listed (archived elsewhere, filtered out). */
  keepListed(order: readonly string[]): void {
    const next = listedSelection(this.state, order);
    if (next !== this.state) this.set(next);
  }
  clear(): void {
    if (this.state.ids.length || this.state.confirm)
      this.set({ ...noSelection, confirm: undefined });
  }
  /** Ask before deleting the picked threads (the selection bar shows the question). */
  ask(confirm: BulkConfirm | undefined): void {
    this.set({ confirm });
  }
  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

const selections = perWindow(() => new HomeSelection());
export const HomeSelectionProvider = selections.Provider;
export const useHomeSelection = selections.use;

/** The picked thread ids and any question pending about them. */
export function useHomeSelectionState(): State {
  const selection = useHomeSelection();
  return useSyncExternalStore(selection.subscribe, selection.getState, selection.getState);
}

/** Whether one thread is picked: a row re-renders only when its own answer changes. */
export function useSelected(threadId: string): boolean {
  const selection = useHomeSelection();
  const read = () => selection.getState().ids.includes(threadId);
  return useSyncExternalStore(selection.subscribe, read, read);
}

export function useRenameTitle(threadId: string): string | undefined {
  const selection = useHomeSelection();
  const read = () =>
    selection.getState().rename?.id === threadId ? selection.getState().rename?.title : undefined;
  return useSyncExternalStore(selection.subscribe, read, read);
}
