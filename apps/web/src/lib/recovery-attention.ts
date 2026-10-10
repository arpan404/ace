import { usePendingSends } from "@ace/client-react";
import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import { recoveryAttention as attention, type RecoveryAttention } from "@ace/ui-core";
import { useMemo, useSyncExternalStore } from "react";
import { dismissedSends, loadDismissed } from "./dismissed-sends.ts";
import { useLayout } from "./layout.tsx";

export function useFailedSendThreads(): ReadonlySet<string> {
  const { storage } = useLayout();
  loadDismissed(storage);
  const dismissed = useSyncExternalStore(dismissedSends.subscribe, dismissedSends.get);
  const sends = usePendingSends();
  return useMemo(
    () =>
      new Set(
        sends
          .filter((send) => send.state === "failed" && !dismissed.has(send.commandId))
          .map((send) => send.threadId),
      ),
    [sends, dismissed],
  );
}

export function recoveryAttention(
  thread: ThreadListEntry,
  models: readonly CatalogModel[] | undefined,
  failed: ReadonlySet<string>,
): RecoveryAttention | undefined {
  return attention(thread, models, failed.has(thread.id));
}

/** A row subscribes only to its own sends and its own dismissal answer. */
export function useFailedSend(threadId: string): boolean {
  const { storage } = useLayout();
  loadDismissed(storage);
  const sends = usePendingSends(threadId);
  const read = () =>
    sends.some((send) => send.state === "failed" && !dismissedSends.get().has(send.commandId));
  return useSyncExternalStore(dismissedSends.subscribe, read, read);
}
