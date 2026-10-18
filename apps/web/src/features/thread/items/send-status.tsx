import type { PendingSend } from "@ace/client";
import { useConnectionState } from "@ace/client-react";
import type { ReactNode } from "react";
import { ClockIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { waitingNote } from "@/lib/daemon-command.ts";
import type { StagedSend } from "../composer/send-store.ts";
import { useWorktreeCreation } from "../worktree/use-worktree-creation.ts";
import { worktreeSpeaks } from "../worktree/worktree-refusal.ts";
import { FailedHeld, FailedSend } from "./failed-send.tsx";
import { sendFailure } from "./send-failure.ts";

/*
 * The line that says how a message on its way is doing, beside it in the composer's strip (or
 * under a new thread's first message). It loads with the thread's other deferred parts.
 */

const isImage = (mimeType: string) => mimeType.startsWith("image/");

/** "Uploading 2 images…", "Uploading a file…". */
function uploadingLabel(staged: StagedSend): string {
  if (staged.attachments.every((file) => !!file.sha256))
    return staged.waitingForEarlier ? "Waiting for an earlier message…" : "Sending…";
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
 * How a message on its way is doing: "Sending…" (or "Will apply when reconnected" offline,
 * "Still waiting for the daemon…" when it's slow), "Uploading 2 images…" while its files
 * finish, and "Not sent" with the reason, Retry and Edit when it can't go. Nothing once the
 * daemon has it, nor while a new thread's worktree card speaks for it.
 */
export function SendStatus(props: {
  threadId: string;
  send: PendingSend | undefined;
  staged: StagedSend | undefined;
}) {
  const online = useConnectionState() === "ready";
  const { send, staged } = props;
  // A new thread's worktree speaks for its message: its card says how the making goes, and
  // offers Retry and the local checkout if it stops.
  const creating =
    send?.payload.type === "thread.create" && send.payload.mode === "worktree"
      ? send.commandId
      : undefined;
  const worktree = useWorktreeCreation(creating).state?.progress;
  if (worktreeSpeaks(worktree, send?.state === "failed" ? send.error : undefined)) return null;
  if (staged?.failed || staged?.uploadInterrupted)
    return <FailedHeld threadId={props.threadId} staged={staged} />;
  if (staged)
    return (
      <Line>
        <Icon icon={ClockIcon} size={12} />
        {uploadingLabel(staged)}
      </Line>
    );
  if (send?.state === "failed")
    return (
      <FailedSend
        threadId={props.threadId}
        commandId={send.commandId}
        payload={send.payload}
        reason={sendFailure(send.error, send.payload)}
        // Git's cleanup fence stopped it: the person may clear a lock its stopped daemon left.
        fenced={send.error === "git_quarantined"}
      />
    );
  if (!send || (send.state !== "saving" && send.state !== "sent")) return null;
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
    <p role="status" className="flex items-center gap-1 pr-1 text-xs text-subtle-foreground">
      {props.children}
    </p>
  );
}
