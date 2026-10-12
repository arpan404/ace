import { usePendingSends } from "@ace/client-react";
import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import { recoveryAttention as attention, type RecoveryAttention } from "@ace/ui-core";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { dismissedSends, loadDismissed } from "./dismissed-sends.ts";
import { useLayout } from "./layout.tsx";
import { liveOwners, pageId, heldSendStore } from "./held-send-store.ts";
import { useSeconds } from "./time.ts";
import { uploadOwnerAlive } from "./upload-owner-lease.ts";

/** Saved holds survive the outbox's memory cache and the page that started them. */
function useHeldFailures() {
  const { storage } = useLayout();
  const store = heldSendStore(storage);
  const all = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [owners, setOwners] = useState<ReadonlySet<string> | null>();
  const foreign = all.some(
    (send) => send.owner !== pageId && send.preparing !== false && !send.failed,
  );
  const now = useSeconds(foreign);
  useEffect(() => {
    if (!all.some((send) => send.owner !== pageId && !send.failed)) return;
    let active = true;
    void liveOwners().then((live) => {
      if (active) setOwners(live ?? null);
    });
    return () => {
      active = false;
    };
  }, [all]);
  return useMemo(
    () =>
      all.filter(
        (send) =>
          !!send.failed ||
          (send.owner !== pageId &&
            send.preparing !== false &&
            owners !== undefined &&
            !owners?.has(send.owner) &&
            !uploadOwnerAlive(storage, send.owner, now)),
      ),
    [all, owners, storage, now],
  );
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
