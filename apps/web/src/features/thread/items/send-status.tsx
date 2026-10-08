import type { PendingSend } from "@ace/client";
import { useConnectionState, useItem, useThread } from "@ace/client-react";
import type { ReactNode } from "react";
import { ClockIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { waitingNote } from "@/lib/daemon-command.ts";
import { type StagedSend, leasable } from "../composer/send-store.ts";
import { useWorktreeCreation } from "../worktree/use-worktree-creation.ts";
import { FailedHeld, FailedSend } from "./failed-send.tsx";
import { sendFailure } from "./send-failure.ts";

/*
 * The line under a bubble while its message is on its way. It loads with the thread's other
 * deferred parts (the bubble shows its time meanwhile): only a message just sent, or one that
 * didn't go, has anything to say here.
 */

const isImage = (mimeType: string) => mimeType.startsWith("image/");

/** "Uploading 2 images…", "Uploading a file…". */
function uploadingLabel(staged: StagedSend): string {
  const files = staged.attachments.length;
  const images = staged.attachments.every((file) => isImage(file.mimeType));
  const noun = images
    ? files === 1
      ? "an image"
      : `${files} images`
    : files === 1
      ? "a file"
      : `${files} files`;
  return `Uploading ${noun}…`;
}

/**
 * Under the person's bubble while its message is on its way: "Sending…" (or "Will apply when
 * reconnected" offline, "Still waiting for the daemon…" when it's slow), "Uploading 2 images…"
 * while its files finish, and "Not sent" with the reason, Retry and Edit when the daemon
 * refused it or couldn't deliver it. Nothing once the daemon has it, nor while a worktree card
 * below speaks for it.
 */
export function SendStatus(props: {
  threadId: string;
  itemId: string;
  send: PendingSend | undefined;
  staged: StagedSend | undefined;
  /** The daemon's notice that the message wasn't delivered, if it wrote one. */
  noticeId: string | undefined;
  /** What the line shows when there's nothing to say about sending (the time on hover). */
  otherwise: ReactNode;
}) {
  const online = useConnectionState() === "ready";
  const notice = useItem(leasable(props.threadId), props.noticeId ?? "");
  const item = useItem(leasable(props.threadId), props.itemId);
  const runId = item?.runId;
  const run = useThread(leasable(props.threadId), [`run:${runId ?? ""}`], (reader) =>
    runId ? reader.run(runId) : undefined,
  );
  const { send, staged } = props;
  // A new thread's worktree speaks for its message under the bubble: its card says how the
  // making goes, and offers Retry and the local checkout if it stops.
  const creating =
    send?.payload.type === "thread.create" && send.payload.mode === "worktree"
      ? send.commandId
      : undefined;
  const worktree = useWorktreeCreation(creating).state?.progress;
  if (worktree) return props.otherwise;
  if (staged?.failed) return <FailedHeld threadId={props.threadId} staged={staged} />;
  if (staged)
    return (
      <Line>
        <Icon icon={ClockIcon} size={12} />
        {uploadingLabel(staged)}
      </Line>
    );
  const refused = send?.state === "failed";
  // Admission can inherit an older active run. Only a later run supersedes this failure.
  if (notice?.type === "notice" && run && run.startedAt > notice.createdAt) return props.otherwise;
  if (refused || notice?.type === "notice") {
    const reason = refused
      ? sendFailure(send?.error, send?.payload)
      : notice?.type === "notice"
        ? (notice.detail ?? notice.text).replace(/^thread\.(send|create): /, "")
        : undefined;
    return (
      <FailedSend threadId={props.threadId} itemId={props.itemId} send={send} reason={reason} />
    );
  }
  if (!send || (send.state !== "saving" && send.state !== "sent")) return props.otherwise;
  const note = waitingNote({ online, slow: send.waiting });
  return (
    <Line>
      <Icon icon={ClockIcon} size={12} />
      {note ?? "Sending…"}
    </Line>
  );
}

function Line(props: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="mt-[5px] flex items-center gap-1 pr-1 text-xs text-subtle-foreground"
    >
      {props.children}
    </p>
  );
}
