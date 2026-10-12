import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useThreadSources } from "../sources/index.ts";
import { QueuedTray } from "./queued.tsx";
import { useThread, useThreadMeta } from "@ace/client-react";
import type { ThreadReader } from "@ace/client";
import { useActiveRootRun, useStopping } from "./stop-state.ts";
import { useQueuedPending } from "./queued-pending.ts";
import { useQueue } from "./use-queue.ts";

const queueOf = (reader: ThreadReader) => reader.queue;

/** Pending sends and daemon entries share the tray, keeping their stable command ids. */
export function QueuedMessages(props: { threadId: string }) {
  const queue = useQueue(props.threadId);
  const pending = useQueuedPending(props.threadId, queue.page, queue.retained);
  const sources = useThreadSources();
  const hashes = [
    ...new Set(
      [...queue.retained, ...pending].flatMap(
        (message) => message.context?.attachments.map((file) => file.sha256) ?? [],
      ),
    ),
  ]
    .toSorted()
    .join();
  const attachments = useDaemonQuery({
    queryKey: ["thread", "queued-attachments", props.threadId, hashes],
    enabled: !!hashes,
    read: (_client, signal) =>
      sources.context.list({ id: props.threadId, workspaceId: "", title: "" }, signal),
  });
  const hold = useThread(props.threadId, ["queue"], queueOf);
  const selectionWaiting = useThreadMeta(props.threadId)?.switch?.state === "queued";
  const active = !!useActiveRootRun(props.threadId);
  const stopping = useStopping(props.threadId);
  const steerReason = !queue.canSteer
    ? "This provider doesn't support steering."
    : selectionWaiting
      ? "Wait for the model or account switch to finish."
      : stopping
        ? "The turn is stopping."
        : (hold?.paused ?? queue.page?.paused)
          ? "Resume the queue before steering."
          : !active
            ? "There is no running turn to steer."
            : queue.failed || !queue.page || (hold && hold.revision !== queue.page.revision)
              ? "Wait for the queue to refresh."
              : undefined;
  return (
    <QueuedTray
      threadId={props.threadId}
      queue={queue}
      pending={pending}
      attachments={attachments.data ?? []}
      steerReason={steerReason}
    />
  );
}
