import type { ThreadReader } from "@ace/client";
import type { QueuedMessage } from "@ace/protocol";
import { useThread, useThreadMeta } from "@ace/client-react";
import type { ReactNode } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useThreadSources } from "../sources/index.ts";
import { QueueNotice, type HeldQueue } from "./queue-notice.tsx";
import { QueuedTray } from "./queued.tsx";
import type { PendingQueued } from "./queued-pending.ts";
import { useActiveRootRun, useStopping } from "./stop-state.ts";
import type { QueueControls } from "./use-queue.ts";

const queueOf = (reader: ThreadReader) => reader.queue;

/**
 * The queue in the composer's strip: why it is held, then its messages, this window's pending
 * sends among them under their stable command ids, with their file previews.
 */
export function QueueStrip(props: {
  threadId: string;
  queue: QueueControls;
  pending: readonly PendingQueued[];
  held: HeldQueue | undefined;
  indicators: ReactNode;
  editing: QueuedMessage | undefined;
  onEdit(message: QueuedMessage | undefined): void;
  onChooseModel(): void;
}) {
  const { queue, pending } = props;
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
      indicators={props.indicators}
      editing={props.editing}
      onEdit={props.onEdit}
      notice={
        props.held && (
          <QueueNotice
            threadId={props.threadId}
            held={props.held}
            queue={queue}
            onChooseModel={props.onChooseModel}
          />
        )
      }
    />
  );
}
