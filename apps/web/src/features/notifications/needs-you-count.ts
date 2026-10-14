import type { CatalogModel } from "@ace/protocol";
import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import { useCallback } from "react";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useNow } from "@/lib/time.ts";
import { recoveryAttention, useFailedSendThreads } from "./recovery-attention.ts";

/** Waiting on a person and not snoozed by them. */
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
    (thread.status.state === "needs_you" || !!recoveryAttention(thread, models, failed)) &&
    thread.archivedAt === undefined &&
    thread.deletedAt === undefined &&
    !((thread.snoozedUntil ?? 0) > now)
  );
}

/** Open requests across unsnoozed threads: the tab title's count. */
export function useNeedsYouCount(): number {
  const models = useModelCatalog();
  const failed = useFailedSendThreads();
  // Snoozes end on the minute; the count follows.
  const minute = Math.floor(useNow() / 60_000);
  const pendingTotal = useCallback(
    (reader: SidebarReader) =>
      reader.ids.reduce((sum, id) => {
        const status = reader.thread(id)?.status;
        return status && waiting(reader, id, minute * 60_000, models, failed)
          ? sum + (status.state === "needs_you" ? status.interactions : 1)
          : sum;
      }, 0),
    [minute, models, failed],
  );
  return useSidebarAll(pendingTotal) ?? 0;
}
