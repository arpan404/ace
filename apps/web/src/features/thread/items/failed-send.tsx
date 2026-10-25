import { useContext, useRef, useState } from "react";
import { TimeContext } from "@/lib/time.ts";
import { uploadClock } from "@/features/thread/composer/upload-interruption.ts";
import { baseName, tokensFromInput } from "@ace/ui-core";
import { retrySend } from "@ace/client";
import { useClient, useThreadMeta } from "@ace/client-react";
import { ArrowClockwiseIcon, PencilSimpleIcon, WarningIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { useHostIdentity } from "@/lib/host-name.ts";
import { newThreadDraftKey } from "@/lib/new-thread-draft-key.ts";
import {
  forgetReturnedStart,
  saveReturnedStart,
  type ReturnedStart,
} from "@/lib/returned-start.ts";
import { dismissSend } from "../composer/dismissed-sends.ts";
import { draftOf, restoreReturnedDraft, type SendPayload } from "../composer/returned-draft.ts";
import {
  leasable,
  markEditing,
  returnDraft,
  saveOpenDraft,
  useEditingHeld,
} from "../composer/send-store.ts";
import {
  canRetry,
  editStaged,
  isRecoverable,
  removeStagedUpload,
  retryStaged,
  type StagedSend,
} from "../composer/staged-sends.ts";
import { useThreadSources } from "../sources/index.ts";
import { ClearStaleLock } from "./clear-stale-lock.tsx";
import { dismissWorktreeStart } from "../worktree/use-worktree-creation.ts";
import { useDiscardSend } from "./use-discard-send.ts";
import { useMachineSearch } from "@/lib/machine-routes.ts";

type CreatePayload = Extract<SendPayload, { type: "thread.create" }>;

/**
 * "Not sent · the reason", with Retry (sends it again), Edit (back into the composer), Discard
 * (drops it, with Undo), and Clear stale lock when Git's cleanup fence (`fenced`) stopped it. Without the message's
 * `payload` (its item isn't loaded) only the line shows.
 */
export function FailedSend(props: {
  threadId: string;
  commandId: string;
  payload: SendPayload | undefined;
  reason: string | undefined;
  fenced?: boolean | undefined;
}) {
  const actions = useSendActions(props.threadId);
  const discard = useDiscardSend();
  const { payload, commandId } = props;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-end gap-x-1 gap-y-0.5">
      <NotSent reason={props.reason} />
      {props.fenced && <ClearStaleLock target={{ threadId: props.threadId }} />}
      {payload && (
        <span className="flex gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={actions.retrying(commandId)}
            onClick={() => actions.retry(commandId, payload)}
          >
            <Icon icon={ArrowClockwiseIcon} size={12} />
            Retry
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={actions.retrying(commandId)}
            onClick={() => actions.edit(commandId, payload)}
          >
            <Icon icon={PencilSimpleIcon} size={12} />
            Edit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={actions.retrying(commandId)}
            onClick={() => discard(commandId, payload)}
          >
            Discard
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
  const machine = useMachineSearch();
  const { storage } = useLayout();
  const host = useHostIdentity()?.hostId;
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  /**
   * A new thread's start back in New thread for its project: its text, files and picks in the
   * composer, its base in the strip, and why (when given) in the strip's notice. A worktree
   * start the daemon kept as failed or cancelled is dismissed there, its message being back.
   */
  const returnStart = async (
    commandId: string,
    payload: CreatePayload,
    returned?: ReturnedStart,
  ) => {
    const draft = draftOf(payload);
    const { writeDraft } = await import("../composer/draft-store.ts");
    // New thread reads its draft under this host and project; elsewhere it would be lost.
    const key = host && newThreadDraftKey(host, payload.workspaceId);
    if (!key || !writeDraft(storage, key, draft)) {
      toast.error({
        title: "Couldn't save the edit",
        description: "The original message is still here.",
      });
      return false;
    }
    if (returned) saveReturnedStart(storage, key, returned);
    else forgetReturnedStart(storage, key);
    dismissSend(storage, commandId);
    if (payload.mode === "worktree") dismissWorktreeStart(client, commandId);
    void navigate({
      to: "/new",
      search: {
        project: payload.workspaceId,
        ...(payload.mode === "worktree" && payload.base ? { base: baseName(payload.base) } : {}),
        ...machine,
      },
      replace: returned !== undefined,
    });
    return true;
  };
  return {
    retrying: (id: string) => pending.has(id),
    retry(commandId: string, payload: SendPayload) {
      if (inFlight.current.has(commandId)) return;
      inFlight.current.add(commandId);
      setPending(new Set(inFlight.current));
      void retrySend(client, commandId, payload)
        .then((outcome) => {
          if (outcome !== "resent") return;
          dismissSend(storage, commandId);
          // A thread.create retried is a new thread start: its pending route moves with it.
          if (payload.type === "thread.create")
            void navigate({
              to: "/t/$threadId",
              params: { threadId: `pending:${commandId}:retry` },
              search: machine,
              replace: true,
            });
        })
        // A replacement whose local write fails is memory-only. Keep the original durable
        // failure visible through reload until Retry saves.
        .catch(() =>
          toast.error({ title: "Couldn't send it again", description: "It is still here." }),
        )
        .finally(() => {
          inFlight.current.delete(commandId);
          setPending(new Set(inFlight.current));
        });
    },
    returnStart,
    edit(commandId: string, payload: SendPayload) {
      if (payload.type === "thread.create") return void returnStart(commandId, payload);
      const draft = draftOf(payload);
      const key = `thread:${threadId}`;
      if (restoreReturnedDraft(storage, key, draft)) dismissSend(storage, commandId);
      else
        toast.error({
          title: "Couldn't save the edit",
          description: "Keep this editor open. The original message is still here.",
        });
    },
  };
}

/**
 * A message held for its uploads that can't go as it is: a file didn't upload, or the page
 * uploading it closed, reloaded or stalled. Any page may then Retry, Edit or Remove it; the
 * first to act claims it and competing actions do nothing (`upload-interruption.ts`). Retry
 * shows only where every file still to upload is in this page.
 */
export function FailedHeld(props: { threadId: string; staged: StagedSend }) {
  const { staged } = props;
  const client = useClient();
  const toast = useToast();
  const sources = useThreadSources();
  const meta = useThreadMeta(leasable(props.threadId));
  const { storage } = useLayout();
  const time = useContext(TimeContext);
  const inFlight = useRef(false);
  // Kept outside this line: the composer remounts on a returned draft with files.
  const editing = useEditingHeld(staged.commandId);
  const setEditing = (on: boolean) => markEditing(staged.commandId, on);
  // One action at a time from this bubble; competing pages are fenced by the claim itself.
  const act = (run: () => Promise<boolean>, failure: { title: string; description: string }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    void run()
      .then((done) => {
        if (!done) toast.error(failure);
      })
      .finally(() => {
        inFlight.current = false;
      });
  };
  const retry = () => {
    if (!meta) return;
    const thread = { id: props.threadId, workspaceId: meta.workspaceId, title: meta.title };
    act(
      () =>
        retryStaged(
          client,
          staged.commandId,
          (file) => sources.context.upload(thread, file, () => {}),
          uploadClock(time.read),
          storage,
        ),
      { title: "It still didn't go", description: "It is still here." },
    );
  };
  const edit = () => {
    const key = `thread:${props.threadId}`;
    const take = (send: StagedSend) => {
      if (editing) return saveOpenDraft(key);
      const draft = {
        text: send.text,
        tokens: send.input ? tokensFromInput(send.input).tokens : [],
        mentions: send.mentions,
        attachments: send.attachments.flatMap((file) =>
          file.sha256 ? [{ sha256: file.sha256, name: file.name }] : [],
        ),
        options: send.options,
      };
      const taken = returnDraft(key, draft);
      if (taken !== undefined) setEditing(true);
      return taken ?? restoreReturnedDraft(storage, key, draft);
    };
    const unfinished = staged.attachments.filter((file) => !file.sha256).map((file) => file.name);
    act(
      async () => {
        if (!(await editStaged(staged.commandId, take, uploadClock(time.read)))) return false;
        dismissSend(storage, staged.commandId);
        setEditing(false);
        // Their bytes went with the page that was uploading them.
        if (unfinished.length)
          toast.error({
            title: "Attach again",
            description: `${unfinished.join(", ")} didn't finish uploading.`,
          });
        return true;
      },
      {
        title: "Couldn't finish the edit",
        description: "Keep this editor open. The original recovery copy is still here.",
      },
    );
  };
  const remove = () =>
    act(() => removeStagedUpload(client, staged.commandId, storage, uploadClock(time.read)), {
      title: "Couldn't remove the message",
      description: "It is still here.",
    });
  const recoverable = isRecoverable(staged, time.read());
  return (
    <div role="alert" className="flex flex-wrap items-center justify-end gap-x-1 gap-y-0.5">
      <NotSent reason={staged.uploadInterrupted ? "Upload interrupted" : staged.failed} />
      <span className="flex gap-1">
        {recoverable && !editing && canRetry(staged) && (
          <Button size="xs" variant="ghost" onClick={retry}>
            <Icon icon={ArrowClockwiseIcon} size={12} />
            Retry
          </Button>
        )}
        {(editing || recoverable) && (
          <Button size="xs" variant="ghost" onClick={edit}>
            <Icon icon={PencilSimpleIcon} size={12} />
            {editing ? "Save edit" : "Edit"}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={remove}>
          Remove
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
      <span className="shrink-0 whitespace-nowrap font-medium">Not sent</span>
      {props.reason && <span className="text-muted-foreground">· {props.reason}</span>}
    </p>
  );
}
