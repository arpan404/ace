import { useInteractions, useThreadError, useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
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
import {
  loadThreadBrowser,
  threadWorkspace,
  ThreadPartsProvider,
  useThreadParts,
} from "@/features/panels/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { ThreadComposer } from "./composer/thread-composer.tsx";
import type { ComposerHandle } from "./composer/composer.tsx";
import { useFileDrop } from "./composer/file-drop.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import type { ThreadRef } from "./sources/index.ts";
import { ForkOpener } from "./transitions/fork-opener.ts";
import { ThreadLoadError } from "./thread-load-error.tsx";
import { SyncingNote, ThreadLoading } from "./thread-loading.tsx";
import { useLatestForkPoint } from "./transitions/use-fork-point.ts";

const ThreadBrowser = lazy(loadThreadBrowser);

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
  preloadDeferred,
} from "./deferred.ts";
import { readingColumn } from "./lib/column.ts";
import { isPendingThread } from "./composer/send-store.ts";
import { useShownTitle } from "./lib/shown-title.ts";
import { DeferredComposerStrip } from "./composer/deferred-cards.ts";
import { DeferredLocalSends } from "./composer/deferred-parts.tsx";
import { UserMessage } from "./items/user-message.tsx";
import { ActivityLine } from "./items/live-head.tsx";
import { LongThreadHotkeys } from "./long/nav-keys.tsx";
import { ThreadNavProvider, useThreadNav } from "./long/nav.tsx";
import { ThreadCrumb } from "./header/thread-crumb.tsx";
import { WorkButton } from "./header/work-button.tsx";
import { createWorkCardStore, WorkCardContext } from "./header/work-card-store.ts";
import { WorkSide } from "./header/work-side.tsx";

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

/** A canonical item or interaction identity, or a search hit's creation sequence. */
export interface ThreadTarget {
  seq?: number;
  itemId?: string;
  /** The words that found it, marked once it is in view. */
  query?: string | undefined;
}

/**
 * A thread: the transcript and composer in the main column; in the header its title, the ⋯
 * menu, the thread details icon and the side panel toggle; its panel tabs include Summary, Changes,
 * terminals, Files and Browser. A long
 * thread adds its turns and search.
 */
export function ThreadView(props: { threadId: string; target?: ThreadTarget | undefined }) {
  // Started from New thread a moment ago: shown until the daemon names the real thread.
  if (isPendingThread(props.threadId)) return <PendingThread threadId={props.threadId} />;
  return (
    <ThreadNavProvider threadId={props.threadId}>
      <Suspense
        fallback={
          <Screen title="">
            <ThreadLoading />
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
  if (requests?.length) use(DeferredComposerStrip.preload());
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
  const [workCard] = useState(createWorkCardStore);
  useHotkey(keymap.workCard.keys, workCard.toggle, { id: "workCard" });
  const thread = useMemo<ThreadRef | undefined>(
    () =>
      meta && title !== undefined
        ? { id, workspaceId: meta.workspaceId, title, provider: meta.provider }
        : undefined,
    [id, meta, title],
  );
  return (
    <ThreadPartsProvider value={parts}>
      <WorkCardContext value={workCard}>
        <Screen
          crumb={meta && <ThreadCrumb threadId={id} />}
          title={
            renaming && thread ? (
              <Suspense fallback={null}>
                <InlineRenameField thread={thread} onDone={() => setRenaming(false)} />
              </Suspense>
            ) : error ? (
              "Thread unavailable"
            ) : (
              (title ?? "")
            )
          }
          progress={meta && !error ? <SyncingNote threadId={id} /> : undefined}
          menu={
            thread && (
              <Suspense fallback={null}>
                <DeferredThreadMenu.Component
                  onAttachments={() => setAttachmentsOpen(true)}
                  thread={thread}
                  onRename={() => setRenaming(true)}
                  onFork={setForking}
                  onMerge={() => setMerging(true)}
                />
              </Suspense>
            )
          }
          tools={thread && !error && <WorkButton threadId={id} />}
          workspace={{ scope: id, definition: threadWorkspace }}
        >
          {error ? (
            <ThreadLoadError error={error} />
          ) : !meta ? (
            <ThreadLoading />
          ) : (
            <ForkOpener value={setForking}>
              <div
                data-thread-column
                className="relative grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
                {...drop.handlers}
              >
                {/* First in the area: Tab reaches an open details card straight after the header. */}
                <WorkSide threadId={id} />
                {drop.overlay}
                {nav.turnsOpen && (
                  <Suspense fallback={null}>
                    <DeferredTurnsPanel.Component nav={nav} />
                  </Suspense>
                )}
                <div className="col-start-1 row-start-1 min-h-0 min-w-0">
                  <Transcript threadId={id} />
                </div>
                <TargetJump target={props.target} pending={requests ?? []} />
                <Suspense fallback={null}>
                  <ThreadBrowser threadId={id} />
                </Suspense>
                {thread && (
                  <ThreadComposer
                    thread={thread}
                    status={meta?.status}
                    composer={composer}
                    requestTarget={props.target?.itemId}
                  />
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
      </WorkCardContext>
    </ThreadPartsProvider>
  );
}

/** Opening the thread at a link's target (a search hit in a subagent thread, say). */
function TargetJump(props: { target: ThreadTarget | undefined; pending: readonly string[] }) {
  const nav = useThreadNav();
  const seq = props.target?.seq;
  const query = props.target?.query;
  const itemId = props.target?.itemId;
  const pending = itemId !== undefined && props.pending.includes(itemId);
  useEffect(() => {
    if (itemId !== undefined) {
      if (pending) nav.jump.live();
      else void nav.jump.toItem(itemId);
    } else if (seq !== undefined) void nav.jump.toSeq(seq, query ? { query } : {});
    else nav.jump.live();
  }, [nav.jump, seq, query, itemId, pending]);
  return null;
}
