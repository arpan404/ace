import { useRef, useState } from "react";
import { tokensFromInput } from "@ace/ui-core";
import type { PendingSend } from "@ace/client";
import { useClient, useItem, useThreadMeta } from "@ace/client-react";
import { CommandId, ThreadId } from "@ace/protocol";
import { ArrowClockwiseIcon, PencilSimpleIcon, WarningIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { dismissSend } from "../composer/dismissed-sends.ts";
import { draftOf, type SendPayload } from "../composer/returned-draft.ts";
import { returnDraft, leasable } from "../composer/send-store.ts";
import { canRetry, retryStaged, unstage, type StagedSend } from "../composer/staged-sends.ts";
import { useThreadSources } from "../sources/index.ts";
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
          <Button
            size="sm"
            variant="ghost"
            disabled={actions.retrying(commandId)}
            onClick={() => actions.retry(commandId, payload)}
          >
            <Icon icon={ArrowClockwiseIcon} size={12} />
            Retry
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={actions.retrying(commandId)}
            onClick={() => actions.edit(commandId, payload)}
          >
            <Icon icon={PencilSimpleIcon} size={12} />
            Edit
          </Button>
        </span>
      )}
    </div>
  );
}

/**
 * Retry releases the original retained message, or sends a refused command under a new id.
 * Edit hands it back to its composer.
 */
export function useSendActions(threadId: string) {
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  return {
    retrying: (id: string) => pending.has(id),
    retry(commandId: string, payload: SendPayload) {
      if (inFlight.current.has(commandId)) return;
      inFlight.current.add(commandId);
      setPending(new Set(inFlight.current));
      void (async () => {
        if (payload.type === "thread.send") {
          let after: CommandId | undefined;
          let revision: number | undefined;
          do {
            const { queue } = await client.request({
              type: "queue.get",
              threadId: payload.threadId,
              limit: 32,
              ...(after ? { after: CommandId.parse(after), expectedRevision: revision } : {}),
            });
            revision = queue.revision;
            if (queue.messages.some((message) => message.id === commandId)) {
              const result = await client.command({
                type: "queue.resume",
                threadId: payload.threadId,
                expectedRevision: revision,
              });
              if (!result.ok) throw new Error(result.error);
              return;
            }
            after = queue.next ?? undefined;
          } while (after);
        }
        const id = `${commandId}:retry`;
        // A thread.create retried is a new thread start: its pending route moves with it.
        await client.enqueue(payload, id).then(
          () => {
            dismissSend(storage, commandId);
            if (payload.type === "thread.create")
              void navigate({
                to: "/t/$threadId",
                params: { threadId: `pending:${id}` },
                replace: true,
              });
          },
          () => {
            if (
              client
                .pendingSends()
                .getSnapshot()
                .some((send) => send.commandId === id)
            ) {
              dismissSend(storage, commandId);
              if (payload.type === "thread.create")
                void navigate({
                  to: "/t/$threadId",
                  params: { threadId: `pending:${id}` },
                  replace: true,
                });
            }
            toast.add({ title: "Couldn't send it again", description: "It is still here." });
          },
        );
      })()
        .catch(() =>
          toast.add({ title: "Couldn't send it again", description: "It is still here." }),
        )
        .finally(() => {
          inFlight.current.delete(commandId);
          setPending(new Set(inFlight.current));
        });
    },
    edit(commandId: string, payload: SendPayload) {
      const draft = draftOf(payload);
      dismissSend(storage, commandId);
      if (payload.type === "thread.create")
        return void import("../composer/draft-store.ts").then(({ writeDraft }) => {
          writeDraft(storage, `new:${payload.workspaceId}`, draft);
          void navigate({ to: "/new", search: { project: payload.workspaceId } });
        });
      const key = `thread:${threadId}`;
      if (!returnDraft(key, draft))
        void import("../composer/draft-store.ts").then(({ writeDraft }) =>
          writeDraft(storage, key, draft),
        );
    },
  };
}

/**
 * A message held for its uploads that can't go as it is (a file didn't upload, or the page
 * closed mid-upload): "Not sent" with why, Retry where this page still has the files (it
 * uploads them again, then sends under the same id), and Edit, which gives the text, the
 * files the daemon holds and the picks back to the composer.
 */
export function FailedHeld(props: { threadId: string; staged: StagedSend }) {
  const { staged } = props;
  const client = useClient();
  const toast = useToast();
  const sources = useThreadSources();
  const meta = useThreadMeta(leasable(props.threadId));
  const { storage } = useLayout();
  const retry = () => {
    if (!meta) return;
    const thread = { id: props.threadId, workspaceId: meta.workspaceId, title: meta.title };
    void retryStaged(client, staged.commandId, (file) =>
      sources.context.upload(thread, file, () => {}),
    ).then((sent) => {
      if (!sent) toast.add({ title: "It still didn't go", description: "It is still here." });
    });
  };
  const edit = () => {
    const draft = {
      text: staged.text,
      tokens: staged.input ? tokensFromInput(staged.input).tokens : [],
      mentions: staged.mentions,
      attachments: staged.attachments.flatMap((file) =>
        file.sha256 ? [{ sha256: file.sha256, name: file.name }] : [],
      ),
      options: staged.options,
    };
    unstage(staged.commandId);
    const key = `thread:${props.threadId}`;
    if (!returnDraft(key, draft))
      void import("../composer/draft-store.ts").then(({ writeDraft }) =>
        writeDraft(storage, key, draft),
      );
  };
  return (
    <div role="alert" className="mt-[5px] flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <NotSent reason={staged.failed} />
      <span className="flex gap-1">
        {canRetry(staged) && (
          <Button size="sm" variant="ghost" onClick={retry}>
            <Icon icon={ArrowClockwiseIcon} size={12} />
            Retry
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={edit}>
          <Icon icon={PencilSimpleIcon} size={12} />
          Edit
        </Button>
      </span>
    </div>
  );
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
