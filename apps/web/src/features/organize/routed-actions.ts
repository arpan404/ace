import type { PinPlacement, ThreadActions, ThreadTarget } from "./use-thread-actions.ts";

/** Where one list row's action goes: its machine's actions, and the thread's id there. */
export interface RowRoute {
  actions: ThreadActions;
  threadId: string;
}

/**
 * Organize actions over the Home list's row ids, each run by the actions of the row's own
 * machine (ADR 0102). A row id names this window's thread or another machine's
 * (`machine:[hostId,threadId]`); `route` resolves it, or returns undefined for a machine this
 * window can't reach now, whose rows are then left alone. Actions on several rows run once per
 * machine with that machine's rows, in the order given, so one machine's pins still lead the
 * group together and each machine offers its own Undo.
 */
export function routedThreadActions(route: (rowId: string) => RowRoute | undefined): ThreadActions {
  const on = <T extends ThreadTarget>(entry: T) => {
    const found = route(entry.id);
    return found && { actions: found.actions, entry: { ...entry, id: found.threadId } };
  };
  /** The entries by machine, in order of first appearance. */
  const byMachine = <T>(
    items: readonly T[],
    rowId: (item: T) => string,
    there: (item: T, threadId: string) => T,
  ) => {
    const groups = new Map<ThreadActions, T[]>();
    for (const item of items) {
      const found = route(rowId(item));
      if (!found) continue;
      const moved = there(item, found.threadId);
      const group = groups.get(found.actions);
      if (group) group.push(moved);
      else groups.set(found.actions, [moved]);
    }
    return [...groups];
  };
  const one =
    <A extends unknown[]>(run: (actions: ThreadActions, entry: ThreadTarget, ...args: A) => void) =>
    (entry: ThreadTarget, ...args: A) => {
      const found = on(entry);
      if (found) run(found.actions, found.entry, ...args);
    };
  const entries = (items: readonly ThreadTarget[]) =>
    byMachine(
      items,
      (item) => item.id,
      (item, id) => ({ ...item, id }),
    );
  const placements = (items: readonly PinPlacement[]) =>
    byMachine(
      items,
      (item) => item.entry.id,
      (item, id) => ({ ...item, entry: { ...item.entry, id } }),
    );
  return {
    settle: one((actions, entry) => actions.settle(entry)),
    unsettle: one((actions, entry) => actions.unsettle(entry)),
    setAutoSettle: one((actions, entry, enabled: boolean) => actions.setAutoSettle(entry, enabled)),
    snooze: one((actions, entry, until: number) => actions.snooze(entry, until)),
    wake: one((actions, entry) => actions.wake(entry)),
    setPinned: one((actions, entry, pinned: boolean) => actions.setPinned(entry, pinned)),
    placePinned: (items) => {
      for (const [actions, group] of placements(items)) actions.placePinned(group);
    },
    placeListed: (items) => {
      for (const [actions, group] of placements(items)) actions.placeListed(group);
    },
    setPinnedMany: (items, pinned) => {
      for (const [actions, group] of entries(items)) actions.setPinnedMany(group, pinned);
    },
    archiveMany: (items) => {
      for (const [actions, group] of entries(items)) actions.archiveMany(group);
    },
    removeMany: (items) => {
      for (const [actions, group] of entries(items)) actions.removeMany(group);
    },
    // Projects belong to one machine: a move only ever reaches the threads on the machine whose
    // project was picked, which the picker asks on (`MoveRequest.hostId`).
    moveMany: (items, to) => {
      for (const [actions, group] of entries(items)) actions.moveMany(group, to);
    },
    setUnread: one((actions, entry, unread: boolean) => actions.setUnread(entry, unread)),
    rename: one((actions, entry, title: string) => actions.rename(entry, title)),
    archive: one((actions, entry, leave?: () => void) => actions.archive(entry, leave)),
    restore: one((actions, entry) => actions.restore(entry)),
    remove: one((actions, entry) => actions.remove(entry)),
    deleteArchived: one((actions, entry) => actions.deleteArchived(entry)),
    newThreadOnMain: one((actions, entry) => actions.newThreadOnMain(entry)),
    copyLink: one((actions, entry) => actions.copyLink(entry)),
  };
}
