import { useInteractions, useThreadError, useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { lazy, Suspense, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TurnActivity } from "@ace/ui-core";
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
import { useTurnActivity } from "./transcript/use-turn-activity.ts";

const ThreadBrowser = lazy(loadThreadBrowser);

/**
 * A thread being started, off the thread route's first paint. New thread warms it as it opens
 * and waits for it before it moves here, so the move never shows an empty pane.
 */
const DeferredPendingThread = deferredComponent(() =>
  import("./pending-thread.tsx").then((m) => m.PendingThreadView),
);
export const preloadPendingThread = DeferredPendingThread.preload;
const AttachmentsSheet = lazy(() =>
  import("./attachments-sheet.tsx").then((module) => ({ default: module.AttachmentsSheet })),
);
const MergeDialog = lazy(() =>
  import("./transitions/merge-dialog.tsx").then((m) => ({ default: m.MergeDialog })),
);
/** The Changes header's git action: loaded with the Changes tab that draws it. */
const ThreadGitAction = lazy(() =>
  import("./header/git-action.tsx").then((m) => ({ default: m.ThreadGitAction })),
);
const ForkDialog = lazy(() =>
  import("./transitions/fork-dialog.tsx").then((m) => ({ default: m.ForkDialog })),
);
import { InlineRenameField } from "@/features/organize/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { findInThread } from "./long/nav-keys.tsx";
import { Transcript } from "./transcript/transcript.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import {
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
import { DelegateBottom } from "./subagent/delegate-bottom.tsx";

/**
 * A thread New thread started a moment ago, until the daemon names it: its view's code loads
 * on demand, drawing the person's message and the live line as the transcript does.
 */
function PendingThread(props: { threadId: string }) {
  const commandId = props.threadId.slice("pending:".length);
  return (
    <Suspense fallback={null}>
      <DeferredPendingThread.Component
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

/** The turn's live line, for a panel that draws it its own way (the Summary's head line). */
function TurnActivityOf(props: {
  threadId: string;
  children(activity: TurnActivity | undefined): ReactNode;
}) {
  return props.children(useTurnActivity(props.threadId));
}

/** Takes the person to the request in the composer's strip: its first control takes focus. */
function focusRequest() {
  // Focus brings it into view.
  document
    .querySelector("[data-composer-strip]")
    ?.querySelector<HTMLElement>("button:not(:disabled), input, textarea, [tabindex='0']")
    ?.focus();
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
  const outer = useThreadParts();
  const forkPoint = useLatestForkPoint(id);
  const parts = useMemo(
    () => ({
      ...outer,
      fork: forkPoint && (() => setForking(forkPoint)),
      gitAction: ThreadGitAction,
      turnActivity: TurnActivityOf,
      showRequest: focusRequest,
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
                {/* A page's question floats just above the composer, on its column: nothing
                    renders below the composer. */}
                <div
                  className="pointer-events-none relative z-20 col-start-1 row-start-1 self-end pb-[calc(var(--composer-clearance,0px)+8px)]"
                  style={{ paddingInline: "var(--transcript-gutter)" }}
                >
                  <div className={readingColumn}>
                    <Suspense fallback={null}>
                      <ThreadBrowser threadId={id} />
                    </Suspense>
                  </div>
                </div>
                {thread && (
                  <DelegateBottom thread={meta}>
                    <ThreadComposer
                      thread={thread}
                      status={meta?.status}
                      composer={composer}
                      requestTarget={props.target?.itemId}
                    />
                  </DelegateBottom>
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
