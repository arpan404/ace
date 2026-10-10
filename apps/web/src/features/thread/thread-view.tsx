import { useInteractions, useThreadError, useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { ListBulletsIcon } from "@phosphor-icons/react";
import {
  lazy,
  Suspense,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { threadWorkspace, ThreadPartsProvider, useThreadParts } from "@/features/panels/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { ThreadComposer } from "./composer/thread-composer.tsx";
import type { ComposerHandle } from "./composer/composer.tsx";
import { useFileDrop } from "./composer/file-drop.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import type { ThreadRef } from "./sources/index.ts";
import { ThreadLink } from "./transitions/thread-link.tsx";
import { ForkOpener } from "./transitions/fork-opener.ts";
import { ThreadLoadError } from "./thread-load-error.tsx";
import { useLatestForkPoint } from "./transitions/use-fork-point.ts";

// Loaded on first open, off the route's first paint.
const PendingThreadView = lazy(() =>
  import("./pending-thread.tsx").then((m) => ({ default: m.PendingThreadView })),
);
const AttachmentsSheet = lazy(() =>
  import("./attachments-sheet.tsx").then((module) => ({ default: module.AttachmentsSheet })),
);
const MergeDialog = lazy(() =>
  import("./transitions/merge-dialog.tsx").then((m) => ({ default: m.MergeDialog })),
);
const ForkDialog = lazy(() =>
  import("./transitions/fork-dialog.tsx").then((m) => ({ default: m.ForkDialog })),
);
import { InlineRenameField } from "@/features/organize/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { findInThread } from "./long/nav-keys.tsx";
import { Transcript } from "./transcript/transcript.tsx";
import { AgentTranscript } from "./transcript/agent-transcript.tsx";
import { SideChatComposer } from "./composer/side-chat-composer.tsx";
import { whenIdle } from "@/lib/idle.ts";
import {
  DeferredAgentComposer,
  DeferredThreadHotkeys,
  DeferredThreadMenu,
  DeferredTurnsPanel,
  DeferredWorkCard,
  preloadDeferred,
} from "./deferred.ts";
import { readingColumn } from "./lib/column.ts";
import { isPendingThread } from "./composer/send-store.ts";
import { useShownTitle } from "./lib/shown-title.ts";
import { DeferredRequestStack } from "./composer/deferred-cards.ts";
import { DeferredLocalSends } from "./composer/deferred-parts.tsx";
import { UserMessage } from "./items/user-message.tsx";
import { ActivityLine } from "./transcript/live-footer.tsx";
import { LongThreadHotkeys } from "./long/nav-keys.tsx";
import { ThreadNavProvider, useThreadNav } from "./long/nav.tsx";
import { useWorkspaceActions, useScopeWorkspace } from "@/lib/workspace/index.ts";

/**
 * A thread New thread started a moment ago, until the daemon names it: its view's code loads
 * on demand, drawing the person's message and the live line as the transcript does.
 */
function PendingThread(props: { threadId: string }) {
  const commandId = props.threadId.slice("pending:".length);
  return (
    <Suspense fallback={null}>
      <PendingThreadView
        threadId={props.threadId}
        parts={{
          column: readingColumn,
          bubble: (
            <>
              <UserMessage threadId={props.threadId} itemId={`input:${commandId}`} />
              <Suspense fallback={null}>
                <DeferredLocalSends.Component threadId={props.threadId} />
              </Suspense>
            </>
          ),
          Line: ActivityLine,
        }}
      />
    </Suspense>
  );
}

/** The Agents panel's follow-up composer, in the panel's own slot. */
function AgentComposer(props: ComponentProps<typeof DeferredAgentComposer.Component>) {
  return (
    <Suspense fallback={null}>
      <DeferredAgentComposer.Component {...props} />
    </Suspense>
  );
}

/** Where a link into the thread points: an item's creation sequence (a search hit elsewhere). */
export interface ThreadTarget {
  seq: number;
  /** The words that found it, marked once it is in view. */
  query?: string | undefined;
}

/**
 * A thread: the transcript and composer in the main column; in the header only its title, the ⋯
 * menu, the work card's button (project, git, actions, editors, sources) and the side panel's
 * toggle; and its side panel of tabs (Changes, Agents, terminals, Files, Browser, …). A long
 * thread adds its turns and search.
 */
export function ThreadView(props: { threadId: string; target?: ThreadTarget | undefined }) {
  // Started from New thread a moment ago: shown until the daemon names the real thread.
  if (isPendingThread(props.threadId)) return <PendingThread threadId={props.threadId} />;
  return (
    <ThreadNavProvider threadId={props.threadId}>
      <Suspense
        fallback={
          <Screen title="Loading thread…">
            <TranscriptSkeleton />
          </Screen>
        }
      >
        <ThreadScreen threadId={props.threadId} target={props.target} />
      </Suspense>
    </ThreadNavProvider>
  );
}

function ThreadScreen(props: { threadId: string; target: ThreadTarget | undefined }) {
  const nav = useThreadNav();
  const meta = useThreadMeta(props.threadId);
  const requests = useInteractions(props.threadId);
  // Requests are part of opening the thread, never deferred until browser idle time.
  if (requests?.length) use(DeferredRequestStack.preload());
  const error = useThreadError(props.threadId);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [forking, setForking] = useState<ForkPoint>();
  const id = props.threadId;
  // The workspace's agent tabs draw with the transcript's own blocks, beside the route's parts.
  const outer = useThreadParts();
  const forkPoint = useLatestForkPoint(id);
  const parts = useMemo(
    () => ({
      ...outer,
      AgentTranscript,
      SideChatComposer,
      AgentComposer,
      fork: forkPoint && (() => setForking(forkPoint)),
    }),
    [outer, forkPoint],
  );
  const { setScreenActions } = useLayout();
  const screenActions = useMemo(
    () => ({
      scope: id,
      rename: () => setRenaming(true),
      fork: forkPoint ? () => setForking(forkPoint) : undefined,
      merge: meta?.lineage ? () => setMerging(true) : undefined,
      attachments: () => setAttachmentsOpen(true),
      find: () => findInThread(nav),
      turns: () => nav.setTurnsOpen(!nav.turnsOpen),
    }),
    [id, forkPoint, nav, meta?.lineage],
  );
  useEffect(() => {
    setScreenActions(screenActions);
    return () => setScreenActions(undefined);
  }, [screenActions, setScreenActions]);
  // Step details and interaction cards load once the transcript has painted.
  useEffect(() => whenIdle(() => void preloadDeferred()), []);
  const title = useShownTitle(id, meta?.title);
  const composer = useRef<ComposerHandle>(null);
  // Files dropped anywhere on the thread, or pasted outside a field, go to its composer.
  const drop = useFileDrop(composer);
  const card = useWorkCard(id);
  const thread = useMemo<ThreadRef | undefined>(
    () =>
      meta && title !== undefined
        ? { id, workspaceId: meta.workspaceId, title, provider: meta.provider }
        : undefined,
    [id, meta, title],
  );
  return (
    <ThreadPartsProvider value={parts}>
      <Screen
        breadcrumb={
          meta?.lineage && (
            <>
              Forked from{" "}
              <ThreadLink threadId={meta.lineage.parentThreadId} fallback="parent thread" />
            </>
          )
        }
        title={
          renaming && thread ? (
            <Suspense fallback={null}>
              <InlineRenameField thread={thread} onDone={() => setRenaming(false)} />
            </Suspense>
          ) : error ? (
            "Thread unavailable"
          ) : (
            (title ?? "Loading thread…")
          )
        }
        menu={
          thread && (
            <Suspense fallback={null}>
              <DeferredThreadMenu.Component
                onAttachments={() => setAttachmentsOpen(true)}
                thread={thread}
                onRename={() => setRenaming(true)}
                onFork={setForking}
              />
            </Suspense>
          )
        }
        tools={
          thread && (
            <IconButton
              icon={ListBulletsIcon}
              label="Work card"
              shortcut="workCard"
              pressed={card.open}
              data-work-card-toggle
              onClick={card.toggle}
            />
          )
        }
        workspace={{
          scope: id,
          definition: threadWorkspace,
          contextPanel: thread && (
            <Suspense fallback={null}>
              {card.mounted && (
                <DeferredWorkCard.Component thread={thread} open={card.open} onClose={card.close} />
              )}
            </Suspense>
          ),
        }}
      >
        {error ? (
          <ThreadLoadError error={error} />
        ) : !meta ? (
          <TranscriptSkeleton />
        ) : (
          <ForkOpener value={setForking}>
            <div
              data-thread-column
              className="relative grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
              {...drop.handlers}
            >
              {drop.overlay}
              {nav.turnsOpen && (
                <Suspense fallback={null}>
                  <DeferredTurnsPanel.Component nav={nav} />
                </Suspense>
              )}
              <div className="col-start-1 row-start-1 min-h-0 min-w-0">
                <Transcript threadId={id} />
              </div>
              <TargetJump target={props.target} />
              {thread && (
                <ThreadComposer thread={thread} status={meta?.status} composer={composer} />
              )}
            </div>
          </ForkOpener>
        )}
        <LongThreadHotkeys />
        {thread && (
          <Suspense fallback={null}>
            <DeferredThreadHotkeys.Component thread={thread} onRename={() => setRenaming(true)} />
          </Suspense>
        )}
        <Suspense fallback={null}>
          {attachmentsOpen && thread && (
            <AttachmentsSheet thread={thread} onClose={() => setAttachmentsOpen(false)} />
          )}
          {merging && thread && <MergeDialog thread={thread} onClose={() => setMerging(false)} />}
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

/**
 * The work card retains each thread's view state and is mounted from
 * its first opening (so a commit form it opened outlives it). ⌥⌘O toggles it; closing with
 * Escape hands focus back to the header's button.
 */
function useWorkCard(threadId: string) {
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const open = workspace.workCard?.open ?? false;
  const toggle = () => {
    const showing = open && !workspace.open;
    if (!showing) actions.setOpen(false);
    actions.setWorkCard({ open: !showing });
  };
  useHotkey(keymap.workCard.keys, toggle, { id: "workCard" });
  const close = (returnFocus: boolean) => {
    actions.setWorkCard({ open: false });
    if (returnFocus)
      (
        document.querySelector<HTMLElement>("header [data-work-card-toggle]") ??
        document.querySelector<HTMLElement>('header button[aria-label="More actions"]')
      )?.focus();
  };
  return {
    open: open && !workspace.open,
    mounted: workspace.workCard !== undefined,
    toggle,
    close,
  };
}
