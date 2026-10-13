import type { PendingSend } from "@ace/client";
import type { PermissionMode, WorktreeCreationProgress } from "@ace/protocol";
import { usePermissionCapabilities } from "@/lib/use-permission-modes.ts";
import { useConnectionState, useIntent, usePendingSends, useThreadMeta } from "@ace/client-react";
import {
  permissionLabel,
  provisionalTitle,
  providerNames,
  type TurnActivity,
  worktreeTabLabel,
} from "@ace/ui-core";
import { GitForkIcon, ShieldIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, type Ref, type ComponentType, type ReactNode } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { iconControl, environmentRow, environmentSurface } from "./composer/composer-styles.ts";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useProjectName } from "@/lib/projects.ts";
import { Composer, type ComposerHandle } from "./composer/composer.tsx";
import { ComposerDock } from "./composer/composer-dock.tsx";
import { startedTitle } from "./composer/send-store.ts";
import type { ThreadRef } from "./sources/index.ts";
import { useSendActions } from "./items/failed-send.tsx";
import { WorktreeCreationCard } from "./worktree/creation-card.tsx";
import { useWorktreeCreation } from "./worktree/use-worktree-creation.ts";
import {
  worktreeSpeaks,
  worktreeUnmade,
  worktreeUnmadeReason,
} from "./worktree/worktree-refusal.ts";
import { PendingModelChip } from "./pending-model-chip.tsx";

/** What the new thread is doing before it exists: a worktree first, then its provider. */
function startingLine(payload: PendingSend["payload"], accepted: boolean): TurnActivity {
  const provider = payload.type === "thread.create" ? providerNames[payload.provider] : "the agent";
  const label =
    payload.type === "thread.create" && payload.mode === "worktree" && !accepted
      ? "Preparing worktree…"
      : `Starting ${provider}…`;
  return { label, tone: "working", elapsedFrom: undefined, current: undefined };
}

/**
 * A new thread from the moment Enter is pressed on New thread (UX audit SY-2): the header
 * reads its provisional title, the person's message is its first bubble, and the live line
 * says what's being prepared. A worktree being made shows as its steps instead, with Cancel and
 * Don't use worktree, and the composer stays available for drafting. When the daemon's receipt (or the
 * worktree's own report) names the thread and its first window has arrived, the route moves to
 * it in place; the transcript there opens on the same bubble. A refused start keeps the bubble
 * with the reason, Retry and Edit; a cancelled worktree keeps its card with Retry and Don't use
 * worktree. A start whose worktree couldn't be made goes back to New thread with its message.
 */
export function PendingThreadView(props: {
  threadId: string;
  /** The transcript's parts, passed in so this view's code carries none of them. */
  parts: {
    /** The reading column's class, so the bubble sits where the thread will have it. */
    column: string;
    /** The person's message as the transcript draws it, with its sending state. */
    bubble: ReactNode;
    /** The live line as the transcript draws it. */
    Line: ComponentType<{ activity: TurnActivity }>;
  };
}) {
  const commandId = props.threadId.slice("pending:".length);
  const entry = usePendingSends(props.threadId).find((send) => send.commandId === commandId);
  const intent = useIntent(commandId);
  const ready = useConnectionState() === "ready";
  const payload = entry?.payload;
  const worktree = useWorktreeCreation(isWorktreeCreate(payload) ? commandId : undefined);
  const progress = worktree.state?.progress;
  const made = progress?.state === "done" || progress?.state === "local";
  const realId = intent?.state === "acked" ? intent.threadId : made ? progress.threadId : undefined;
  // Leasing the real thread loads its first window, so the move to it shows no skeleton.
  const meta = useThreadMeta(realId);
  const navigate = useNavigate();
  const composer = useRef<ComposerHandle>(null);
  useEffect(() => {
    if (realId && meta) {
      composer.current?.preserveDraft(`thread:${realId}`);
      void navigate({ to: "/t/$threadId", params: { threadId: realId }, replace: true });
    }
  }, [realId, meta, navigate]);
  const projectName = useProjectName();
  const workspaceId = payload?.type === "thread.create" ? payload.workspaceId : undefined;
  // New thread worked the title out as it sent; after a reload, the same rule on the message.
  const title =
    startedTitle(commandId) ?? (payload ? provisionalTitle(payload.input) : "New thread");
  const failed = entry?.state === "failed" || intent?.state === "failed";
  // A start refused because its worktree couldn't be made goes back to New thread: the
  // person's message in its composer to edit and send again, the reason in its top strip. The
  // message's own refusals keep Retry and Edit here; a cancel keeps its card.
  const code = entry?.error ?? intent?.error;
  const returning = isWorktreeCreate(payload) && failed && worktreeUnmade(code);
  const { returnStart } = useSendActions(props.threadId);
  const returned = useRef(false);
  useEffect(() => {
    if (!returning || !payload || returned.current) return;
    returned.current = true;
    void returnStart(commandId, payload, worktreeUnmadeReason(code, progress)).then((moved) => {
      if (!moved) returned.current = false;
    });
  }, [returning, payload, progress, code, commandId, returnStart]);
  if (!entry && !intent && ready)
    return (
      <Screen title="New thread">
        <div role="alert" className="h-full">
          <EmptyState
            icon={WarningCircleIcon}
            title="This new thread isn't on this device any more"
            description="It may have started from another window. Find it in the list."
            action={
              <Link to="/" className={buttonVariants({ size: "sm" })}>
                Back to Home
              </Link>
            }
          />
        </div>
      </Screen>
    );
  return (
    <Screen title={title} subtitle={workspaceId && projectName(workspaceId)}>
      <div className="flex h-full min-h-0 flex-col">
        {/* The same column and spacing the transcript opens with, so the move to the
            real thread doesn't shift the bubble. */}
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <div className={`${props.parts.column} pt-6 pb-16`}>
            <div role="feed" aria-label="Transcript" aria-busy={!failed}>
              <div role="article" className="pb-7">
                {props.parts.bubble}
              </div>
            </div>
            {worktreeSpeaks(progress, failed ? code : undefined) ? (
              <WorktreeCreationCard state={worktree.state} onAction={worktree.act} />
            ) : (
              payload && !failed && <props.parts.Line activity={startingLine(payload, !!realId)} />
            )}
          </div>
        </div>
        {isWorktreeCreate(payload) && (
          <PendingComposer
            thread={{
              id: payload.context?.draftId ?? "",
              workspaceId: payload.workspaceId,
              title,
              draft: true,
              provider: payload.provider,
              instanceId: payload.instanceId,
            }}
            draftKey={`thread:${props.threadId}`}
            composer={composer}
            model={payload.model}
            options={payload.options}
            permission={payload.permissionMode}
            progress={progress}
          />
        )}
      </div>
    </Screen>
  );
}

const isWorktreeCreate = (
  payload: PendingSend["payload"] | undefined,
): payload is Extract<PendingSend["payload"], { type: "thread.create" }> =>
  payload?.type === "thread.create" && payload.mode === "worktree";

const never = async () => false;

/**
 * The composer where the thread's will be, while the thread is still being made: its shape and
 * its attachment controls, ready for a draft of the next message. Sending waits for the thread.
 */
function PendingComposer({
  composer,
  thread,
  draftKey,
  model,
  options,
  permission,
  progress,
}: {
  thread: ThreadRef;
  draftKey: string;
  composer: Ref<ComposerHandle>;
  model: string | undefined;
  options: Readonly<Record<string, unknown>> | undefined;
  permission: PermissionMode | undefined;
  progress: WorktreeCreationProgress | undefined;
}) {
  const reason = useId();
  const { capabilities } = usePermissionCapabilities(thread.provider, undefined, thread.instanceId);
  const approvals = permissionLabel(permission, capabilities);
  return (
    <ComposerDock>
      <p id={reason} className="sr-only">
        You can send more once the thread has started.
      </p>
      <Composer
        ref={composer}
        thread={thread}
        draftKey={draftKey}
        keepsAttachments
        busy={false}
        onSubmit={never}
        controls={
          <Tip label={`Approvals: ${approvals}. Available when the thread starts.`} side="top">
            <button
              type="button"
              aria-disabled
              aria-label={`Approvals: ${approvals}`}
              className={iconControl}
            >
              <ShieldIcon aria-hidden size={16} />
            </button>
          </Tip>
        }
        trailing={
          <PendingModelChip
            provider={thread.provider}
            instanceId={thread.instanceId}
            model={model}
            options={options}
          />
        }
        environment={
          // Only while the worktree is made: once it stops, its card above says how it ended.
          (!progress || progress.state === "running" || progress.state === "cancelling") && (
            <section aria-label="Environment" className={environmentSurface}>
              <div className={environmentRow}>
                <p role="status" className="flex w-fit min-w-0 max-w-full items-center gap-1">
                  <GitForkIcon aria-hidden size={14} className="shrink-0" />
                  <span className="truncate">{worktreeTabLabel(progress)}</span>
                </p>
              </div>
            </section>
          )
        }
        placeholder="Draft your next message while the worktree is prepared"
        shortPlaceholder="Draft your next message"
        sendBlocked={{
          reason: "The thread is still starting",
          describedBy: reason,
        }}
      />
    </ComposerDock>
  );
}
