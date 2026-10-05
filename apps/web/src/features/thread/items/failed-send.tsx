import type { PendingSend } from "@ace/client";
import { useClient, useItem } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { ArrowClockwiseIcon, PencilSimpleIcon, WarningIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { writeDraft } from "../composer/draft-store.ts";
import { dismissSend } from "../composer/dismissed-sends.ts";
import { draftOf, type SendPayload } from "../composer/returned-draft.ts";
import { returnDraft } from "../composer/send-store.ts";
import { leasable } from "../lib/pending-thread-id.ts";
import { commandOf } from "./pending-sends.ts";

/** "Not sent · the reason", with Retry (sends it again) and Edit (back into the composer). */
export function FailedSend(props: {
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
      <NotSent reason={props.reason} />
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

/** "Not sent · the reason": the line on its own, and the head of the line with its actions. */
export function NotSent(props: { reason: string | undefined }) {
  return (
    <p className="flex min-w-0 items-center gap-1 text-xs text-status-failed">
      <Icon icon={WarningIcon} size={12} />
      <span className="font-medium">Not sent</span>
      {props.reason && <span className="text-muted-foreground">· {props.reason}</span>}
    </p>
  );
}
