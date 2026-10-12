import { usePendingSends } from "@ace/client-react";
import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import { recoveryAttention as attention, type RecoveryAttention } from "@ace/ui-core";
import { useMemo, useSyncExternalStore } from "react";
import { dismissedSends, loadDismissed } from "./dismissed-sends.ts";
import { useLayout } from "./layout.tsx";
import { heldSendStore } from "./held-send-store.ts";

/** Saved holds survive the outbox's memory cache and the page that started them. */
function useHeldFailures() {
  const { storage } = useLayout();
  const store = heldSendStore(storage);
  const all = useSyncExternalStore(store.subscribe, store.get, store.get);
  return useMemo(() => all.filter((send) => !!send.failed || send.uploadInterrupted), [all]);
}

export function useFailedSendThreads(): ReadonlySet<string> {
  const { storage } = useLayout();
  loadDismissed(storage);
  const dismissed = useSyncExternalStore(dismissedSends.subscribe, dismissedSends.get);
  const sends = usePendingSends();
  const held = useHeldFailures();
  return useMemo(
    () =>
      new Set(
        [
          ...sends.filter((send) => send.state === "failed"),
          ...held.filter(
            (send) =>
              !sends.some(
                (pending) => pending.commandId === send.commandId && pending.state !== "failed",
              ),
          ),
        ]
          .filter((send) => !dismissed.has(send.commandId))
          .map((send) => send.threadId),
      ),
    [sends, held, dismissed],
  );
}

export function recoveryAttention(
  thread: ThreadListEntry,
  models: readonly CatalogModel[] | undefined,
  failed: ReadonlySet<string>,
): RecoveryAttention | undefined {
  return attention(thread, models, failed.has(thread.id));
}

/** A row reads its own pending sends, saved holds and dismissal answer. */
export function useFailedSend(threadId: string): boolean {
  const { storage } = useLayout();
  loadDismissed(storage);
  const sends = usePendingSends(threadId);
  const held = useHeldFailures();
  const read = () =>
    sends.some((send) => send.state === "failed" && !dismissedSends.get().has(send.commandId)) ||
    held.some(
      (send) =>
        send.threadId === threadId &&
        !dismissedSends.get().has(send.commandId) &&
        !sends.some(
          (pending) => pending.commandId === send.commandId && pending.state !== "failed",
        ),
    );
  return useSyncExternalStore(dismissedSends.subscribe, read, read);
}
