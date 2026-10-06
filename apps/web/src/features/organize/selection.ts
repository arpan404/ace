import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import {
  listedSelection,
  noSelection,
  selectRange,
  toggleSelected,
  type ListSelection,
} from "@ace/ui-core";
import { useMemo, useSyncExternalStore } from "react";

/** A bulk action waiting on the person's yes: the selection bar's dialog asks. */
export type BulkConfirm = "archive" | "delete";

interface State extends ListSelection {
  confirm: BulkConfirm | undefined;
}

/**
 * The Home threads picked for a bulk action, one per window (keyed by its client, like the
 * organize overlay), so the list, its selection bar and the palette share it.
 */
export class HomeSelection {
  private state: State = { ...noSelection, confirm: undefined };
  private listeners = new Set<() => void>();
  getState = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
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
  /** Ask before archiving or deleting the picked threads (the selection bar shows the question). */
  ask(confirm: BulkConfirm | undefined): void {
    this.set({ confirm });
  }
  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

const selections = new WeakMap<ClientApi, HomeSelection>();

export function useHomeSelection(): HomeSelection {
  const client = useClient();
  return useMemo(() => {
    let selection = selections.get(client);
    if (!selection) {
      selection = new HomeSelection();
      selections.set(client, selection);
    }
    return selection;
  }, [client]);
}

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
