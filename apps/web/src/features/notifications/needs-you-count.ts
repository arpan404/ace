import type { CatalogModel } from "@ace/protocol";
import type { SidebarReader } from "@ace/client";
import { isRemoteChild, isSnoozedToTime } from "@ace/ui-core";
import { useSidebar } from "@ace/client-react";
import { useCallback, useState } from "react";
import { useLiveList } from "@/lib/live-connection.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useNow } from "@/lib/time.ts";
import { recoveryAttention, useFailedSendThreads } from "./recovery-attention.ts";

/** Waiting on this person (not a paired machine's child) and not snoozed by them to a time. */
function waiting(
  reader: SidebarReader,
  id: string,
  now: number,
  models: readonly CatalogModel[] | undefined,
  failed: ReadonlySet<string>,
): boolean {
  const thread = reader.thread(id);
  return (
    !!thread &&
    !isRemoteChild(thread) &&
    (thread.status.state === "needs_you" || !!recoveryAttention(thread, models, failed)) &&
    thread.archivedAt === undefined &&
    thread.deletedAt === undefined &&
    // A snooze to a time the person chose keeps it out; one waiting on an event never does.
    !isSnoozedToTime(thread, now)
  );
}

const countKeys = ["ids", "threads", "unconfirmed"] as const;

/**
 * Open requests across unsnoozed threads: the tab title's count, from a current list only.
 * While the list isn't current (offline, reconnecting, catching up, or read back from disk) it
 * neither recounts from that copy nor drops: it holds the last count from a current list, and
 * never less than this device's failed sends. So it errs high, never low: a request answered
 * elsewhere meanwhile may still count until the list is current, but one that was waiting is
 * never hidden. A first load from disk has no count to hold and shows only failed sends.
 */
export function useNeedsYouCount(): number {
  const models = useModelCatalog();
  const failed = useFailedSendThreads();
  // Snoozes end on the minute; the count follows.
  const minute = Math.floor(useNow() / 60_000);
  const pendingTotal = useCallback(
    (reader: SidebarReader) =>
      reader.ids.reduce((sum, id) => {
        if (reader.unconfirmed) return failed.has(id) ? sum + 1 : sum;
        const status = reader.thread(id)?.status;
        return status && waiting(reader, id, minute * 60_000, models, failed)
          ? sum + (status.state === "needs_you" ? status.interactions : 1)
          : sum;
      }, 0),
    [minute, models, failed],
  );
  const total = useSidebar(countKeys, pendingTotal) ?? 0;
  const live = useLiveList();
  const [held, setHeld] = useState(0);
  if (live && held !== total) setHeld(total);
  return live ? total : Math.max(held, failed.size);
}
