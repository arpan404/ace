import { usePendingSends } from "@ace/client-react";
import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import { threadAttention, unavailableSelection } from "@ace/ui-core";
import { useMemo, useSyncExternalStore } from "react";
import { dismissedSends, loadDismissed } from "@/lib/dismissed-sends.ts";
import { useLayout } from "@/lib/layout.tsx";

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
): string | undefined {
  const reason = threadAttention(thread);
  if (reason === "model_unavailable" || unavailableSelection(models, thread.execution))
    return "Pick a model";
  if (reason === "not_sent" || failed.has(thread.id)) return "Message not sent";
  if (reason === "restart") return "Stopped by a restart";
  if (reason === "stopped") return "Agent stopped";
  if (reason === "uncertain") return "Review a message";
  if (reason === "manual") return "Queue paused";
  return undefined;
}
