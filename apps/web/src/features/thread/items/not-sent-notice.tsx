import { useItem, useThread } from "@ace/client-react";
import { ThreadId, type Item } from "@ace/protocol";
import { noticeText } from "@ace/ui-core";
import type { SendPayload } from "../composer/returned-draft.ts";
import { FailedSend } from "./failed-send.tsx";
import { inputItemId, useDismissedSends, useQueuedCommands } from "./pending-sends.ts";

type Notice = Extract<Item, { type: "notice" }>;

/** The message as the daemon holds it, sent again as it was: its words and its files. */
function payloadOf(threadId: string, item: Item | undefined): SendPayload | undefined {
  if (item?.type !== "message") return undefined;
  return {
    type: "thread.send",
    threadId: ThreadId.parse(threadId),
    input: item.parts,
    ...(item.attachments?.length
      ? {
          context: {
            mentions: [],
            attachments: item.attachments.map((file) => ({ sha256: file.sha256 })),
          },
        }
      : {}),
  };
}

/**
 * The daemon's notice that a message it admitted couldn't be delivered, where the daemon put it
 * (just after that message): "Not sent · the reason" with Retry and Edit. It says nothing once
 * the message went after all (the provider echoed it, or a later turn started from it), while
 * the daemon still keeps it in the thread's queue (the queue speaks for it), or once the person
 * resent it or took it back to edit.
 */
export function NotSentNotice(props: { threadId: string; notice: Notice; commandId: string }) {
  const { notice, commandId } = props;
  const item = useItem(props.threadId, inputItemId(commandId));
  const runId = item?.runId;
  const run = useThread(props.threadId, [`run:${runId ?? ""}`], (reader) =>
    runId ? reader.run(runId) : undefined,
  );
  const dismissed = useDismissedSends();
  const queued = useQueuedCommands(props.threadId);
  if (dismissed.has(commandId) || queued.has(commandId)) return null;
  if (item?.type === "message" && item.nativeId) return null;
  // Admission can inherit an older active run. Only a later run supersedes this failure.
  if (run && run.startedAt > notice.createdAt) return null;
  return (
    <FailedSend
      threadId={props.threadId}
      commandId={commandId}
      payload={payloadOf(props.threadId, item)}
      reason={noticeText(notice.detail ?? notice.text)}
      fenced={notice.details?.code === "git_quarantined"}
    />
  );
}
