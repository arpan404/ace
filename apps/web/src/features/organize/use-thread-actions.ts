import { useClient } from "@ace/client-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { deferredPart } from "@/lib/deferred-part.ts";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { useArchiveConfirmation, useDeleteConfirmation } from "./delete-confirmation.ts";
import { leftRunningOn } from "./left-running.ts";
import { useOrganizeOverlay } from "./overlay.ts";
import type { ThreadActions, ThreadActionsDeps } from "./thread-action-types.ts";

export type {
  PinPlacement,
  SnoozeWakeOn,
  ThreadActions,
  ThreadActionsDeps,
  ThreadTarget,
} from "./thread-action-types.ts";
export { undoWindowMs } from "./undo-window.ts";

/**
 * What the actions do loads after the first paint (ADR 0056): once the browser is idle, or on
 * the first action. The list's state and the overlay that shows an action at once stay eager.
 */
const code = deferredPart(() =>
  import("./thread-actions-impl.ts").then((module) => module.threadActionsNow),
);

/**
 * Every list action as a durable daemon command (ADR 0057), so the organization follows the
 * person to every device. Each shows its effect at once and undoes it, with a toast saying why,
 * only when the daemon refuses it; offline it waits and applies on reconnect. Small changes the
 * list already shows (settle, snooze, pin, rename, restore) say nothing more. Actions that take
 * a thread out of sight (archive, move) confirm with a toast offering Undo, which sends the
 * opposite command.
 *
 * Delete submits the permanent command immediately, including to the durable outbox when
 * offline. Its persistence must not depend on a toast or the lifetime of this window.
 * Moving to another project keeps the pin, as the daemon does, and Undo moves it back. Bulk
 * actions offer one Undo for all,
 * except delete. The Home context menu and the thread's ⋯ menu both use these, so
 * labels, toasts and Undo match wherever the person acts.
 */
export function useThreadActions(): ThreadActions {
  const overlay = useOrganizeOverlay();
  const confirmation = useDeleteConfirmation();
  const archiving = useArchiveConfirmation();
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  const machine = useMachineSearch();
  return useMemo(
    () =>
      threadActionsOn({
        overlay,
        confirmation,
        archiving,
        client,
        toast,
        navigate,
        router,
        machine,
      }),
    [overlay, client, toast, navigate, router, confirmation, archiving, machine],
  );
}

/**
 * The organize actions against one machine's client (`useThreadActions` for the view's own).
 * Once their code is in, each runs at once, as a key press or click expects. Before that, calls
 * wait for it and then run in the order they were made; if it can't load, each says so.
 */
export function threadActionsOn(deps: ThreadActionsDeps): ThreadActions {
  code.warm();
  let actions: ThreadActions | undefined;
  const loaded = () => {
    const make = code.current();
    if (make) actions ??= make(deps);
    return actions;
  };
  /** Calls still waiting for the code: later ones wait behind them, so order holds. */
  let waiting = 0;
  const run = (call: (actions: ThreadActions) => void) => {
    const now = waiting === 0 ? loaded() : undefined;
    if (now) return call(now);
    waiting++;
    void code.load().then(
      () => {
        waiting--;
        const ready = loaded();
        if (ready) call(ready);
      },
      () => {
        waiting--;
        deps.toast.error({
          title: "Couldn't do that",
          description: "ace couldn't load what it needs. Check the connection and try again.",
        });
      },
    );
  };
  return {
    settle: (entry) => run((a) => a.settle(entry)),
    unsettle: (entry) => run((a) => a.unsettle(entry)),
    setAutoSettle: (entry, enabled) => run((a) => a.setAutoSettle(entry, enabled)),
    snooze: (entry, until, wake, label) => run((a) => a.snooze(entry, until, wake, label)),
    wake: (entry) => run((a) => a.wake(entry)),
    setPinned: (entry, pinned) => run((a) => a.setPinned(entry, pinned)),
    placePinned: (placements) => run((a) => a.placePinned(placements)),
    placeListed: (placements) => run((a) => a.placeListed(placements)),
    setPinnedMany: (entries, pinned) => run((a) => a.setPinnedMany(entries, pinned)),
    archiveMany: (entries, archived) => run((a) => a.archiveMany(entries, archived)),
    archiveManyNow: (entries) => run((a) => a.archiveManyNow(entries)),
    // Read at once: callers ask before an action, to word their question.
    leftRunning: (entries) => leftRunningOn(deps.client, entries),
    removeMany: (entries) => run((a) => a.removeMany(entries)),
    moveMany: (entries, to) => run((a) => a.moveMany(entries, to)),
    setUnread: (entry, unread) => run((a) => a.setUnread(entry, unread)),
    rename: (entry, title) => run((a) => a.rename(entry, title)),
    archive: (entry, leave) => run((a) => a.archive(entry, leave)),
    restore: (entry) => run((a) => a.restore(entry)),
    remove: (entry) => run((a) => a.remove(entry)),
    deleteArchived: (entry) => run((a) => a.deleteArchived(entry)),
    newThreadOnMain: (entry) => run((a) => a.newThreadOnMain(entry)),
    copyLink: (entry) => run((a) => a.copyLink(entry)),
  };
}
