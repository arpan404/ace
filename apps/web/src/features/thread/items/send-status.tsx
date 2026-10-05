import type { PendingSend } from "@ace/client";
import { useClient, useConnectionState, useItem, usePendingSends } from "@ace/client-react";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import type { ReactNode } from "react";
import {
  ArrowClockwiseIcon,
  ClockIcon,
  PencilSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { sendFailure, waitingNote } from "@/lib/daemon-command.ts";
import { useLayout } from "@/lib/layout.tsx";
import { writeDraft } from "../composer/draft-store.ts";
import {
  dismissSend,
  localAttachment,
  returnDraft,
  type ReturnedDraft,
  type StagedSend,
} from "../composer/send-store.ts";
import { leasable } from "../lib/pending-thread-id.ts";
import { useDeliveryFailures, useStaged } from "./pending-sends.ts";

/** The outbox entry or the staged message behind a bubble, by its transcript key. */
export function useLocalSend(
  threadId: string,
  itemId: string,
): { send: PendingSend | undefined; staged: StagedSend | undefined } {
  const pending = usePendingSends(threadId);
  const staged = useStaged(threadId);
  return {
    send: pending.find((entry) => entry.itemId === itemId),
    staged: staged.find((entry) => `input:${entry.commandId}` === itemId),
  };
}

/** The text a message carries, as written. */
export function inputText(input: readonly { type: string; text?: string }[]): string {
  return input.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
}

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
 * refused it or couldn't deliver it. Nothing once the daemon has it.
 */
export function SendStatus(props: {
  threadId: string;
  itemId: string;
  send: PendingSend | undefined;
  staged: StagedSend | undefined;
  /** What the line shows when there's nothing to say about sending (the time on hover). */
  otherwise: ReactNode;
}) {
  const online = useConnectionState() === "ready";
  const failures = useDeliveryFailures(leasable(props.threadId));
  const commandId = props.send?.commandId ?? commandOf(props.itemId);
  const noticeId = commandId === undefined ? undefined : failures.get(commandId);
  const notice = useItem(leasable(props.threadId), noticeId ?? "");
  const { send, staged } = props;
  if (staged)
    return (
      <Line>
        <Icon icon={ClockIcon} size={12} />
        {uploadingLabel(staged)}
      </Line>
    );
  const refused = send?.state === "failed";
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

function commandOf(itemId: string): string | undefined {
  return itemId.startsWith("input:") ? itemId.slice("input:".length) : undefined;
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

/** "Not sent · the reason", with Retry (sends it again) and Edit (back into the composer). */
function FailedSend(props: {
  threadId: string;
  itemId: string;
  send: PendingSend | undefined;
  reason: string | undefined;
}) {
  const item = useItem(leasable(props.threadId), props.itemId);
  const actions = useSendActions(props.threadId);
  const payload: SendPayload | undefined =
    props.send?.payload ??
    (item?.type === "message"
      ? {
          type: "thread.send",
          threadId: ThreadId.parse(props.threadId),
          input: item.parts,
          ...(item.attachments?.length
            ? {
                context: {
                  mentions: [],
                  attachments: item.attachments.map((file) => ({ sha256: file.sha256 })),
                },
              }
            : {}),
        }
      : undefined);
  const commandId = props.send?.commandId ?? commandOf(props.itemId);
  return (
    <div role="alert" className="mt-[5px] flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <p className="flex min-w-0 items-center gap-1 text-xs text-status-failed">
        <Icon icon={WarningIcon} size={12} />
        <span className="font-medium">Not sent</span>
        {props.reason && <span className="text-muted-foreground">· {props.reason}</span>}
      </p>
      {payload && commandId && (
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => actions.retry(commandId, payload)}>
            <Icon icon={ArrowClockwiseIcon} size={12} />
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.edit(commandId, payload)}>
            <Icon icon={PencilSimpleIcon} size={12} />
            Edit
          </Button>
        </span>
      )}
    </div>
  );
}

type SendPayload = Extract<CommandPayload, { type: "thread.send" | "thread.create" }>;

/** What Edit gives back to the composer: the text, mentions, files and picks it carried. */
export function draftOf(payload: SendPayload): ReturnedDraft {
  return {
    text: inputText(payload.input),
    mentions: payload.context?.mentions.map((mention) => mention.path) ?? [],
    attachments: (payload.context?.attachments ?? []).map((file) => ({
      sha256: file.sha256,
      name: localAttachment(file.sha256)?.name ?? "Attachment",
    })),
    options: payload.options,
  };
}

/**
 * Retry sends a failed message again under a new command id (the daemon keeps its refusal of
 * the old one); Edit hands it back to its composer. Either way the failed bubble goes.
 */
export function useSendActions(threadId: string) {
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { storage } = useLayout();
  return {
    retry(commandId: string, payload: SendPayload) {
      const id = crypto.randomUUID();
      // A thread.create retried is a new thread start: its pending route moves with it.
      void client.enqueue(payload, id).then(
        () => {
          dismissSend(storage, commandId);
          if (payload.type === "thread.create")
            void navigate({
              to: "/t/$threadId",
              params: { threadId: `pending:${id}` },
              replace: true,
            });
        },
        () => toast.add({ title: "Couldn't send it again", description: "It is still here." }),
      );
    },
    edit(commandId: string, payload: SendPayload) {
      const draft = draftOf(payload);
      dismissSend(storage, commandId);
      if (payload.type === "thread.create") {
        writeDraft(storage, `new:${payload.workspaceId}`, draft);
        void navigate({ to: "/new", search: { project: payload.workspaceId } });
        return;
      }
      const key = `thread:${threadId}`;
      if (!returnDraft(key, draft)) writeDraft(storage, key, draft);
    },
  };
}
