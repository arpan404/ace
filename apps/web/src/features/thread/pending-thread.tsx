import type { PendingSend } from "@ace/client";
import { useConnectionState, useIntent, usePendingSends, useThreadMeta } from "@ace/client-react";
import { providerNames, type TurnActivity } from "@ace/ui-core";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, type ComponentType, type ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useProjectName } from "@/lib/projects.ts";
import { startedTitle } from "./composer/send-store.ts";

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
 * says what's being prepared. When the daemon's receipt names the thread and its first window
 * has arrived, the route moves to it in place; the transcript there opens on the same bubble.
 * A refused start keeps the bubble with the reason, Retry and Edit.
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
  const realId = intent?.state === "acked" ? intent.threadId : undefined;
  // Leasing the real thread loads its first window, so the move to it shows no skeleton.
  const meta = useThreadMeta(realId);
  const navigate = useNavigate();
  useEffect(() => {
    if (realId && meta)
      void navigate({ to: "/t/$threadId", params: { threadId: realId }, replace: true });
  }, [realId, meta, navigate]);
  const projectName = useProjectName();
  const payload = entry?.payload;
  const workspaceId = payload?.type === "thread.create" ? payload.workspaceId : undefined;
  // New thread worked the title out as it sent (after a reload the daemon's arrives instead).
  const title = startedTitle(commandId) ?? "New thread";
  const failed = entry?.state === "failed" || intent?.state === "failed";
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
        {/* The same column, marker and spacing the transcript opens with, so the move to the
            real thread doesn't shift the bubble. */}
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <div className={`${props.parts.column} pt-6 pb-16`}>
            <div className="flex justify-center pb-4">
              <Marker variant="separator" className="text-xs text-subtle-foreground">
                <MarkerContent>Beginning of thread</MarkerContent>
              </Marker>
            </div>
            <div role="feed" aria-label="Transcript" aria-busy={!failed}>
              <div role="article" className="pb-7">
                {props.parts.bubble}
              </div>
            </div>
            {payload && !failed && <props.parts.Line activity={startingLine(payload, !!realId)} />}
          </div>
        </div>
      </div>
    </Screen>
  );
}
