import { useThreadError, useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { threadWorkspace, ThreadPartsProvider, useThreadParts } from "@/features/panels/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { ThreadComposer } from "./composer/thread-composer.tsx";
import { GitButton, OpenButton, RunButton } from "./header/header-actions.tsx";
import { PinnedSummary, SummaryToggle } from "./header/summary.tsx";
import type { ThreadRef } from "./sources/index.ts";
import { ForkOpener } from "./transitions/fork-opener.ts";

// Loaded on first open, off the route's first paint.
const RenameDialog = lazy(() =>
  import("./header/rename-dialog.tsx").then((m) => ({ default: m.RenameDialog })),
);
const ForkDialog = lazy(() =>
  import("./transitions/fork-dialog.tsx").then((m) => ({ default: m.ForkDialog })),
);
import { Transcript } from "./transcript/transcript.tsx";
import { AgentTranscript } from "./transcript/agent-transcript.tsx";
import { useProjectName } from "@/lib/projects.ts";
import { whenIdle } from "@/lib/idle.ts";
import {
  DeferredCatchUpCard,
  DeferredThreadMenu,
  DeferredTurnsPanel,
  preloadDeferred,
} from "./deferred.ts";
import { readingColumn } from "./lib/column.ts";
import { useCatchUp, useReadMarker } from "./long/catch-up.ts";
import { LongThreadButtons } from "./long/header-buttons.tsx";
import { ThreadNavProvider, useThreadNav } from "./long/nav.tsx";

/** Where a link into the thread points: an item's creation sequence (a search hit elsewhere). */
export interface ThreadTarget {
  seq: number;
  /** The words that found it, marked once it is in view. */
  query?: string | undefined;
}

/**
 * A thread: the transcript and composer in the main column, Run · Open · Commit in the header,
 * and its workspace (Changes, Agents, Preview, Devices, … beside it; Terminal and Logs below).
 * A long thread adds its turns, search and a catch-up card for the reader who was away.
 */
export function ThreadView(props: { threadId: string; target?: ThreadTarget | undefined }) {
  return (
    <ThreadNavProvider threadId={props.threadId}>
      <ThreadScreen threadId={props.threadId} target={props.target} />
    </ThreadNavProvider>
  );
}

function ThreadScreen(props: { threadId: string; target: ThreadTarget | undefined }) {
  const nav = useThreadNav();
  const meta = useThreadMeta(props.threadId);
  const error = useThreadError(props.threadId);
  const [renaming, setRenaming] = useState(false);
  const [forking, setForking] = useState<ForkPoint>();
  const id = props.threadId;
  const projectName = useProjectName();
  // The workspace's agent tabs draw with the transcript's own blocks, beside the route's parts.
  const outer = useThreadParts();
  const parts = useMemo(() => ({ ...outer, AgentTranscript }), [outer]);
  // Step details and interaction cards load once the transcript has painted.
  useEffect(() => whenIdle(() => void preloadDeferred()), []);
  const title = meta?.title;
  const thread = useMemo<ThreadRef | undefined>(
    () => (meta && title !== undefined ? { id, workspaceId: meta.workspaceId, title } : undefined),
    [id, meta, title],
  );
  return (
    <ThreadPartsProvider value={parts}>
      <Screen
        title={title ?? "Loading thread…"}
        subtitle={meta && projectName(meta.workspaceId)}
        menu={
          thread && (
            <Suspense fallback={null}>
              <DeferredThreadMenu.Component
                thread={thread}
                onRename={() => setRenaming(true)}
                onFork={setForking}
              />
            </Suspense>
          )
        }
        actions={
          thread && (
            <>
              <RunButton thread={thread} />
              <OpenButton thread={thread} />
              <GitButton thread={thread} />
            </>
          )
        }
        summary={
          thread && (
            <>
              <LongThreadButtons />
              <SummaryToggle thread={thread} />
            </>
          )
        }
        workspace={{ scope: id, definition: threadWorkspace }}
      >
        {error ? (
          <div role="alert" className="h-full">
            <EmptyState
              icon={WarningCircleIcon}
              title="This thread couldn't be loaded"
              description={`The daemon said: ${error.message}. The agents keep working; try again from the list.`}
              action={
                <Link to="/" className={buttonVariants({ size: "sm" })}>
                  Back to Home
                </Link>
              }
            />
          </div>
        ) : !meta ? (
          <TranscriptSkeleton />
        ) : (
          <ForkOpener value={setForking}>
            <div className="relative flex h-full min-h-0 flex-col">
              {thread && !nav.turnsOpen && <PinnedSummary thread={thread} />}
              {nav.turnsOpen && (
                <Suspense fallback={null}>
                  <DeferredTurnsPanel.Component nav={nav} />
                </Suspense>
              )}
              <div className="min-h-0 flex-1">
                <Transcript threadId={id} overlay={<CatchUpSlot threadId={id} />} />
              </div>
              <TargetJump target={props.target} />
              {thread && <ThreadComposer thread={thread} status={meta?.status} />}
            </div>
          </ForkOpener>
        )}
        <Suspense fallback={null}>
          {renaming && thread && (
            <RenameDialog thread={thread} onClose={() => setRenaming(false)} />
          )}
          {forking && thread && (
            <ForkDialog thread={thread} point={forking} onClose={() => setForking(undefined)} />
          )}
        </Suspense>
      </Screen>
    </ThreadPartsProvider>
  );
}

/** The shape of a transcript while its first window arrives: an ask, a work line, an answer. */
function TranscriptSkeleton() {
  return (
    <LoadingRegion label="thread" className={`${readingColumn} flex flex-col pt-16`}>
      <Skeleton className="ml-auto h-14 w-3/5 rounded-[16px_16px_4px_16px]" />
      <Skeleton className="mt-10 h-3 w-48" />
      <SkeletonText lines={4} className="mt-6" />
    </LoadingRegion>
  );
}

/** Opening the thread at a link's target (a search hit in a subagent thread, say). */
function TargetJump(props: { target: ThreadTarget | undefined }) {
  const nav = useThreadNav();
  const seq = props.target?.seq;
  const query = props.target?.query;
  useEffect(() => {
    if (seq !== undefined) void nav.jump.toSeq(seq, query ? { query } : {});
  }, [nav.jump, seq, query]);
  return null;
}

/** The catch-up card while there is news since this device last read the thread. */
function CatchUpSlot(props: { threadId: string }) {
  const nav = useThreadNav();
  const { ready, catchUp, dismiss } = useCatchUp(props.threadId);
  useReadMarker(props.threadId, nav, ready);
  if (!catchUp) return null;
  return (
    <Suspense fallback={null}>
      <DeferredCatchUpCard.Component
        threadId={props.threadId}
        catchUp={catchUp}
        onDismiss={dismiss}
        onLive={() => {
          dismiss();
          nav.jump.live();
        }}
      />
    </Suspense>
  );
}
