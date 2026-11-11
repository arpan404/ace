import { useEffect, useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { useConnectionState } from "@ace/client-react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { ForgePrDetail, ForgePrStatus, ForgeRepository } from "@ace/protocol";
import {
  allCommits,
  prParticipants,
  prPollInterval,
  type CodeScope,
  type GateKey,
} from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { DiffStat } from "@/components/diff-stat.tsx";
import { cn } from "@/lib/cn.ts";
import { PrActivity } from "./pr-activity.tsx";
import { PrHeader } from "./pr-header.tsx";
import { PrPageHeader } from "./pr-page-header.tsx";
import { PrSummary } from "./pr-summary.tsx";
import { PrChecks } from "./pr-checks.tsx";
import { PrChecksTally } from "./pr-checks-list.tsx";
import { PrPeople } from "./pr-people.tsx";
import { TextAction } from "./pr-text-action.tsx";
import { PrQuoteProvider } from "./pr-quote.tsx";
import { PrUiProvider } from "./pr-ui-store.tsx";
import { PrChecksPill } from "./pr-presentation.tsx";
import { PrFiles, preloadPrFiles } from "./pr-files.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { useFreshSinceReconnect } from "./query-state.tsx";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { prDetailKey, prDetailStaleMs, readPrDetail } from "@/lib/forge-pr-detail.ts";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrReviewWorkspace, usePrReview } from "./pr-review-context.tsx";
import { PrReviewButton } from "./pr-review-popover.tsx";
import { ForgeCompletions } from "./forge-completions.tsx";
import { PrSuggestionBatch } from "./pr-suggestions.tsx";
import { usePrActions } from "./pr-actions.ts";
import { PrOverflowMenu } from "./pr-overflow-menu.tsx";
import { PrDialogs, type PrDialog } from "./pr-dialogs.tsx";
import { PrDetails } from "./pr-details.tsx";
import { PrMergeCommitDialog } from "./pr-merge-commit.tsx";
import { PrWriteStatus } from "./pr-write-status.tsx";
import { PrFailure } from "./pr-detail-states.tsx";
import { PrPageSkeleton, type PrSeed } from "./pr-page-skeleton.tsx";
import { PrMergeBox } from "./pr-merge-box.tsx";
import { useBlockingItems } from "./pr-attention.tsx";
import { prShortcut } from "./pr-shortcuts.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { ForgeContentScope } from "./rich/scope.ts";
import { useTaskSave } from "./rich/use-task-save.ts";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { PrTabs, type PrTab } from "./pr-tabs.tsx";

export type { PrTab } from "./pr-tabs.tsx";

export function prWorkspaceTab(tab: string): PrTab {
  return tab === "timeline" || tab === "commits"
    ? "timeline"
    : tab === "code" || tab === "files"
      ? "code"
      : tab === "checks"
        ? "checks"
        : "summary";
}

/** "1 comment", "9 comments". */
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A page's column: the header and every tab, Code included, keep to it. */
const pageWidth = "mx-auto w-full max-w-[64rem]";

/** Scrolled this far into a tab, the header folds its title block away. */
const condenseAt = 64;

/** Whether a cached forge read belongs to this PR: its lifecycle, merge state, stack, reviews. */
function belongsTo(query: Query, workspaceId: string, status: ForgePrStatus): boolean {
  const [scope, workspace, subject, kind] = query.queryKey;
  if (scope !== "forge" || workspace !== workspaceId) return false;
  const key = JSON.stringify(subject);
  return (
    key === JSON.stringify(status.ref) ||
    (kind === "stack-memberships" && key === JSON.stringify(status.ref.repository))
  );
}

/** The Summary tab's context: how many files are marked viewed, else the checks in a line. */
function SummaryContext(props: { detail: ForgePrDetail }) {
  const viewed = usePrReview()?.state?.viewed;
  if (!viewed) return <PrChecksPill status={props.detail.status} />;
  const count = viewed.filter((file) => file.state.toUpperCase() === "VIEWED").length;
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {`${count} / ${props.detail.changedFiles} viewed`}
    </span>
  );
}

function PrDetailLoaded(props: {
  context: PrWorkspaceContext;
  tab: PrTab;
  onTab(tab: string): void;
  refreshing: boolean;
  refreshFailed: string | undefined;
  hostThreadId?: string | undefined;
  extensions?: PrWorkspaceExtensions | undefined;
  onBack?: (() => void) | undefined;
  onOpen(number: number): void;
  page?: boolean | undefined;
}) {
  const { context } = props;
  const readable = props.page ? pageWidth : undefined;
  const { detail } = context;
  const [dialog, setDialog] = useState<PrDialog>();
  const [commitWhen, setCommitWhen] = useState<"now" | "auto">();
  const actions = usePrActions({
    context,
    extensions: props.extensions,
    hostThreadId: props.hostThreadId,
    openConflicts: () => setDialog("conflicts"),
    editCommit: setCommitWhen,
  });
  const [checkFocus, setCheckFocus] = useState<{ id: string; seq: number }>();
  const [codeFocus, setCodeFocus] = useState<{ path: string; line?: number; seq: number }>();
  // Which commits Code shows, held here so a commit in the Timeline opens there.
  const [codeScope, setCodeScope] = useState<CodeScope>(allCommits);
  const openCommit = (sha: string) => {
    setCodeScope({ kind: "commits", from: sha, to: sha });
    props.onTab("code");
  };
  // `line` rides along for the Code tab to land on; it opens the file either way.
  const openCode = (path?: string, line?: number) => {
    props.onTab("code");
    if (path)
      setCodeFocus((current) => ({
        path,
        ...(line === undefined ? {} : { line }),
        seq: (current?.seq ?? 0) + 1,
      }));
  };
  const openCheck = (id?: string) => {
    props.onTab("checks");
    if (id) setCheckFocus((current) => ({ id, seq: (current?.seq ?? 0) + 1 }));
  };
  // A gate in the merge box jumps to its detail: the checks, the reviewers, the conflicts.
  const onGate = (key: GateKey) => {
    if (key === "checks") openCheck();
    else if (key === "reviews") {
      props.onTab("summary");
      document
        .getElementById("pr-reviewers")
        ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    } else if (key === "conflicts" && actions.primary.kind === "resolve") void actions.runPrimary();
    else if (key === "ended") props.onTab("timeline");
  };
  // Blocked, the header's merge says so in words and leads here: the Summary's merge box.
  const showBlocking = () => {
    props.onTab("summary");
    requestAnimationFrame(() =>
      document.getElementById("pr-merge")?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
    );
  };
  const blocking = useBlockingItems(detail);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  // Each tab keeps its own fold: scrolled down in Code, the header stays folded there only.
  const [condensed, setCondensed] = useState<Record<PrTab, boolean>>({
    summary: false,
    timeline: false,
    code: false,
    checks: false,
  });
  const onScroll = (tab: PrTab, top: number) =>
    setCondensed((current) => {
      const was = current[tab];
      // Fold once past the title block; unfold only back at the top, so it can't flicker.
      const next = was ? top > 0 : top > condenseAt;
      return next === was ? current : { ...current, [tab]: next };
    });
  const refresh = () => void actions.refresh();
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const status = detail.status;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const shortcut = prShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === "open")
      void openWeb(status.url).catch(() => toast.error({ title: "Couldn't open GitHub" }));
    else props.onTab(shortcut);
  };
  const editable = !!actions.lifecycle.snapshot?.editableFields.length;
  const repository = detail.status.ref.repository;
  const scope = useMemo(
    () => ({ workspaceId: context.workspaceId, repository }),
    [context.workspaceId, repository],
  );
  // A ticked task box edits the description against the version it was read at, and only
  // while that version's body is the one on screen.
  const snapshot = actions.lifecycle.snapshot;
  const descriptionTasks = useTaskSave(
    snapshot?.editableFields.includes("body") &&
      snapshot.metadata.body === detail.body &&
      !actions.lifecycle.blocked
      ? (body: string) => actions.lifecycle.apply({ kind: "edit", changes: { body } })
      : undefined,
    snapshot?.version ?? "",
  );
  const menu = (
    <PrOverflowMenu
      actions={actions}
      extensions={props.extensions}
      hostThreadId={props.hostThreadId}
      refreshing={props.refreshing}
      onRefresh={refresh}
      onEdit={() => setDialog("edit")}
      onRevert={() => setDialog("revert")}
      onRequestReview={() => setDialog("review")}
      onLock={() => setDialog("lock")}
      onLinkIssue={() => setDialog("link-issue")}
      onDeleteBranch={() => setDialog("delete-branch")}
    />
  );
  // A locked conversation takes comments only from collaborators who can push.
  const conversation = actions.lifecycle.snapshot?.conversation;
  const lockedOut = !!conversation?.locked && !conversation.viewerCanComment;
  const canRequestReview = detail.status.state === "open";
  const participants = useCallback(() => prParticipants(detail), [detail]);
  // Shortcuts work anywhere in the panel; `contents` keeps the layout the article's. On a
  // page it is the page's one scroller instead.
  return (
    <ForgeContentScope value={scope}>
      <div
        role="presentation"
        data-pr-scroller={props.page ? "" : undefined}
        className={props.page ? "flex min-h-0 flex-1 flex-col overflow-y-auto" : "contents"}
        onKeyDown={onKeyDown}
      >
        <ForgeCompletions
          workspaceId={context.workspaceId}
          repository={detail.status.ref.repository}
          participants={participants}
        >
          <PrUiProvider key={JSON.stringify(detail.status.ref)}>
            <PrQuoteProvider onConversation={() => props.onTab("timeline")}>
              <PrReviewWorkspace
                key={JSON.stringify(detail.status.ref)}
                workspaceId={context.workspaceId}
                detail={detail}
                disabled={context.disabled}
                commentsLocked={lockedOut}
                onRefresh={refresh}
                onReread={context.reread}
                header={
                  <div>
                    <div className={readable}>
                      {props.page ? (
                        <PrPageHeader
                          actions={actions}
                          extensions={props.extensions}
                          onBlocked={showBlocking}
                          onBack={props.onBack}
                          menu={menu}
                        />
                      ) : (
                        <PrHeader
                          actions={actions}
                          extensions={props.extensions}
                          condensed={condensed[props.tab]}
                          onBack={props.onBack}
                          onBlocked={showBlocking}
                          blockingCount={blocking.length}
                          menu={menu}
                        />
                      )}
                      {props.refreshFailed && (
                        <p
                          role="status"
                          className="flex items-center gap-2 px-[var(--forge-gutter,1rem)] pb-1 text-xs"
                        >
                          <span className="min-w-0 truncate text-muted-foreground">
                            {`Couldn't refresh: ${props.refreshFailed}`}
                          </span>
                          <Button size="xs" onClick={refresh}>
                            Retry
                          </Button>
                        </p>
                      )}
                      <PrWriteStatus actions={actions} refreshing={props.refreshing} />
                      <PrSuggestionBatch />
                    </div>
                  </div>
                }
              >
                <PrTabs
                  tab={props.tab}
                  onTab={props.onTab}
                  onScroll={onScroll}
                  readable={readable}
                  // Finish review stays in reach once the header (with its Review) scrolls away.
                  pinned={{ code: <PrReviewButton finish /> }}
                  counts={{
                    timeline: detail.status.comments.length,
                    code: detail.changedFiles,
                    checks: detail.status.checks.length,
                  }}
                  context={{
                    // On a page the Summary needs no counter; how many files are viewed is Code's.
                    summary: props.page ? (
                      detail.additions !== undefined && detail.deletions !== undefined ? (
                        <DiffStat
                          additions={detail.additions}
                          deletions={detail.deletions}
                          className="text-xs"
                        />
                      ) : null
                    ) : (
                      <SummaryContext detail={detail} />
                    ),
                    timeline: (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                        <span>{counted(detail.status.comments.length, "comment")}</span>
                        <span aria-hidden className="text-subtle-foreground">
                          ·
                        </span>
                        <span>{counted(detail.commits, "commit")}</span>
                        <span aria-hidden className="text-subtle-foreground">
                          ·
                        </span>
                        <TextAction
                          aria-label={`Order: ${order === "newest" ? "newest first" : "oldest first"}`}
                          onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
                        >
                          {order === "newest" ? "Newest first" : "Oldest first"}
                        </TextAction>
                      </div>
                    ),
                    code: null,
                    checks: props.page ? (
                      <PrChecksTally checks={detail.status.checks} />
                    ) : (
                      <PrChecksPill status={detail.status} />
                    ),
                  }}
                  panels={{
                    summary: (
                      <PrSummary
                        context={context}
                        extensions={props.extensions}
                        stack={actions.stack}
                        onOpen={props.onOpen}
                        onOpenCode={openCode}
                        onEdit={editable ? () => setDialog("edit") : undefined}
                        merge={
                          <PrMergeBox
                            actions={actions}
                            onGate={onGate}
                            attention={{
                              workspaceId: context.workspaceId,
                              hostThreadId: props.hostThreadId,
                              disabled: context.disabled,
                              onRefresh: context.refresh,
                              onOpenCode: openCode,
                              onOpenCheck: openCheck,
                            }}
                          />
                        }
                        about={
                          <PrDetails
                            actions={actions}
                            onDialog={setDialog}
                            people={
                              <PrPeople
                                context={context}
                                extensions={props.extensions}
                                assignees={snapshot?.metadata.assignees}
                                onRequestReview={
                                  canRequestReview ? () => setDialog("review") : undefined
                                }
                                onEdit={editable ? () => setDialog("edit") : undefined}
                              />
                            }
                          />
                        }
                        onTasks={descriptionTasks}
                      />
                    ),
                    timeline: (
                      <PrActivity
                        workspaceId={context.workspaceId}
                        detail={detail}
                        order={order}
                        onOpenCommit={openCommit}
                        // On a page the column already sets the width and the edges.
                        className={props.page ? "mx-0 max-w-none" : undefined}
                      />
                    ),
                    checks: (
                      <div className="px-[var(--forge-gutter,1rem)] pt-3 pb-10">
                        <PrChecks
                          context={context}
                          refreshing={props.refreshing}
                          focus={checkFocus}
                          hostThreadId={props.hostThreadId}
                          onRefresh={refresh}
                          onOpen={props.onOpen}
                          onOpenCode={openCode}
                        />
                      </div>
                    ),
                    code: (
                      <PrFiles
                        workspaceId={context.workspaceId}
                        repository={detail.status.ref.repository}
                        detail={detail}
                        context={context}
                        focus={codeFocus}
                        scope={codeScope}
                        onScope={setCodeScope}
                      />
                    ),
                  }}
                />
                <PrDialogs
                  actions={actions}
                  hostThreadId={props.hostThreadId}
                  open={dialog}
                  onClose={() => setDialog(undefined)}
                />
                <PrMergeCommitDialog
                  actions={actions}
                  when={commitWhen}
                  onClose={() => setCommitWhen(undefined)}
                />
              </PrReviewWorkspace>
            </PrQuoteProvider>
          </PrUiProvider>
        </ForgeCompletions>
      </div>
    </ForgeContentScope>
  );
}

export function PrDetail(props: {
  workspaceId: string;
  repository?: ForgeRepository | undefined;
  number: number;
  /** The state the tab last saw, so the loading outline shows the number in its colour. */
  state?: ForgePrStatus["state"] | undefined;
  /** What a list row already says about the PR, shown for real while it loads. */
  seed?: PrSeed | undefined;
  tab: string;
  onTab(tab: string): void;
  onState?: ((state: ForgePrStatus["state"]) => void) | undefined;
  /** The task whose side panel shows this PR. */
  hostThreadId?: string | undefined;
  onBack?(): void;
  onOpen(number: number): void;
  extensions?: PrWorkspaceExtensions | undefined;
  /** Shown as a page of its own rather than in a side panel. */
  page?: boolean | undefined;
}) {
  // Only a refresh someone asked for (or a write's reconciliation) holds writes; polls don't.
  const [refreshing, setRefreshing] = useState(false);
  const ready = useConnectionState() === "ready";
  const cache = useQueryClient();
  const queryKey = prDetailKey(props.workspaceId, props.repository, props.number);
  const query = useDaemonQuery<ForgePrDetail>({
    queryKey,
    retry: false,
    staleTime: prDetailStaleMs,
    // Kept in memory, and so between sessions, for a while after the panel closes: opening the
    // PR again paints what was last read and reads it again behind it.
    gcTime: keptForgeMs,
    refetchOnReconnect: "always",
    // Re-read while GitHub is still deciding: running checks or mergeability not computed yet.
    // The thread's work card polls on the same rule, so both views agree.
    refetchInterval: (q) => prPollInterval(q.state.data?.status),
    read: (client, signal) =>
      readPrDetail(
        client,
        { workspaceId: props.workspaceId, repository: props.repository, number: props.number },
        signal,
      ),
  });
  const detail = query.data;
  // What an earlier session kept is shown at once but is not current: writes wait for the
  // read behind it. (`isStale` is read so this view re-renders when that read lands.)
  const unconfirmed = query.isStale && cache.getQueryState(queryKey)?.isInvalidated === true;
  const onState = props.onState;
  useEffect(() => {
    if (detail) onState?.(detail.status.state);
  }, [detail, onState]);
  // An open pull request warms its diff renderer while the browser is idle.
  useEffect(() => whenIdle(preloadPrFiles), []);
  const fresh = useFreshSinceReconnect(query.dataUpdatedAt);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const status = detail?.status;
      const [result] = await Promise.all([
        query.refetch(),
        status &&
          cache.refetchQueries({
            type: "active",
            predicate: (q) => belongsTo(q, props.workspaceId, status),
          }),
      ]);
      return !result.isError;
    } finally {
      setRefreshing(false);
    }
  };
  // After a review write: the PR (its threads), or every read of it but its changed files,
  // without holding other writes the way a refresh someone asked for does.
  const reread = async (scope: "threads" | "all") => {
    const status = detail?.status;
    await Promise.all([
      query.refetch(),
      scope === "all" &&
        status &&
        cache.refetchQueries({
          type: "active",
          predicate: (q) =>
            belongsTo(q, props.workspaceId, status) &&
            q.queryKey[3] !== "file-pages" &&
            q.queryKey[3] !== "review-state",
        }),
    ]);
  };
  const context: PrWorkspaceContext | undefined = detail
    ? {
        workspaceId: props.workspaceId,
        detail,
        disabled:
          !fresh || unconfirmed || query.isError || refreshing || detail.writeState !== undefined,
        refresh,
        reread,
      }
    : undefined;
  return (
    <article
      aria-label={`Pull request #${props.number}`}
      className={cn(
        "@container/pr relative flex h-full min-h-0 flex-col bg-panel [--forge-gutter:1rem]",
        props.page && "sm:[--forge-gutter:2rem]",
      )}
    >
      {context ? (
        <PrDetailLoaded
          context={context}
          tab={prWorkspaceTab(props.tab)}
          onTab={props.onTab}
          refreshing={refreshing}
          refreshFailed={query.isError && ready ? query.error.message : undefined}
          hostThreadId={props.hostThreadId}
          extensions={props.extensions}
          onBack={props.onBack}
          onOpen={props.onOpen}
          page={props.page}
        />
      ) : query.error ? (
        <PrFailure
          repository={props.repository}
          number={props.number}
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <PrPageSkeleton
          number={props.number}
          seed={props.seed}
          onBack={props.page ? props.onBack : undefined}
          readable={props.page ? pageWidth : undefined}
        />
      )}
    </article>
  );
}
