import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { ReactNode } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useThreadSources } from "../sources/index.ts";
import { QueueNotice, type HeldQueue } from "./queue-notice.tsx";
import { QueuedTray } from "./queued.tsx";
import type { PendingQueued } from "./queued-pending.ts";
import { useStopping } from "./stop-state.ts";
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
  /** Put the caret in the composer, where a queued message is edited. */
  onEditInComposer(): void;
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
  const stopping = useStopping(props.threadId);
  // A pending model or account switch never holds a steer: it applies at the next turn.
  const steerReason = !queue.canSteer
    ? "This provider doesn't support steering."
    : stopping
      ? "The turn is stopping."
      : (hold?.paused ?? queue.page?.paused)
        ? "Resume the queue before steering."
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
      onEditInComposer={props.onEditInComposer}
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
