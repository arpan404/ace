import { useEffect, useState, type KeyboardEvent, type ReactNode, type UIEvent } from "react";
import { useConnectionState } from "@ace/client-react";
import { ChatCircleIcon, GitCommitIcon, ArrowsDownUpIcon } from "@phosphor-icons/react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { ForgePrDetail, ForgePrStatus, ForgeRepository } from "@ace/protocol";
import { prPollInterval } from "@ace/ui-core";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { PrActivity } from "./pr-activity.tsx";
import { PrHeader } from "./pr-header.tsx";
import { PrPageHeader } from "./pr-page-header.tsx";
import { PrSummary } from "./pr-summary.tsx";
import { PrComposer } from "./pr-composer.tsx";
import { PrChecksPill } from "./pr-presentation.tsx";
import { PrFiles, preloadPrFiles } from "./pr-files.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { useFreshSinceReconnect } from "./query-state.tsx";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { prDetailKey, prDetailStaleMs, readPrDetail } from "@/lib/forge-pr-detail.ts";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrReviewWorkspace, usePrReview } from "./pr-review-context.tsx";
import { PrSuggestionBatch } from "./pr-suggestions.tsx";
import { usePrActions } from "./pr-actions.ts";
import { PrOverflowMenu } from "./pr-overflow-menu.tsx";
import { PrDialogs, type PrDialog } from "./pr-dialogs.tsx";
import { PrWriteStatus } from "./pr-write-status.tsx";
import { PrFailure, PrGhost } from "./pr-detail-states.tsx";
import { PrGatesRow } from "./pr-gates-row.tsx";
import { prShortcut } from "./pr-shortcuts.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { openExternal } from "@/boot/open-external.ts";
import type { GateKey } from "./pr-gates.ts";

export type PrTab = "summary" | "timeline" | "code";

export function prWorkspaceTab(tab: string): PrTab {
  return tab === "timeline" || tab === "commits"
    ? "timeline"
    : tab === "code" || tab === "files"
      ? "code"
      : "summary";
}

/** A page's reading width: the header, summary and timeline; the Code tab takes all of it. */
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

/**
 * The tab bar: Summary · Timeline · Code as one segmented group, with the active tab's context
 * (checks, or counters and order) at its right end. Each tab body is its own scroller.
 */
function PrTabs(props: {
  tab: PrTab;
  onTab(tab: string): void;
  context: Record<PrTab, ReactNode>;
  panels: Record<PrTab, ReactNode>;
  onScroll(tab: PrTab, top: number): void;
  /** On a page of its own: the bar and the reading tabs keep a readable width; Code is full. */
  readable?: string | undefined;
}) {
  const order: PrTab[] = ["summary", "timeline", "code"];
  const names: Record<PrTab, string> = { summary: "Summary", timeline: "Timeline", code: "Code" };
  return (
    <Tabs
      value={props.tab}
      onValueChange={(value) => typeof value === "string" && props.onTab(value)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-t border-border px-4 py-2">
        <div className={cn("flex items-center justify-between gap-2", props.readable)}>
          <TabsList aria-label="Pull request detail" className="rounded-md bg-muted p-0.5">
            {order.map((tab) => (
              <TabsTab key={tab} value={tab} className="h-6 data-active:bg-panel">
                {names[tab]}
              </TabsTab>
            ))}
          </TabsList>
          <div className="flex min-w-0 items-center gap-2">{props.context[props.tab]}</div>
        </div>
      </div>
      {order.map((tab) => (
        <TabsPanel
          key={tab}
          value={tab}
          className="overflow-auto border-t border-border"
          onScroll={(e: UIEvent<HTMLDivElement>) => props.onScroll(tab, e.currentTarget.scrollTop)}
        >
          {props.readable && tab !== "code" ? (
            <div className={props.readable}>{props.panels[tab]}</div>
          ) : (
            props.panels[tab]
          )}
        </TabsPanel>
      ))}
    </Tabs>
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
  const actions = usePrActions({
    context,
    extensions: props.extensions,
    hostThreadId: props.hostThreadId,
    openConflicts: () => setDialog("conflicts"),
  });
  const [behindOpen, setBehindOpen] = useState(false);
  const [revealChecks, setRevealChecks] = useState(0);
  const [codeFocus, setCodeFocus] = useState<{ path: string; seq: number }>();
  const openCode = (path?: string) => {
    props.onTab("code");
    if (path) setCodeFocus((current) => ({ path, seq: (current?.seq ?? 0) + 1 }));
  };
  // A gate jumps to its detail: the checks, the reviewers, the conflicts, the update menu.
  const onGate = (key: GateKey) => {
    if (key === "checks") {
      props.onTab("summary");
      setRevealChecks((n) => n + 1);
    } else if (key === "reviews") {
      props.onTab("summary");
      document
        .getElementById("pr-reviewers")
        ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    } else if (key === "conflicts" && actions.primary.kind === "resolve") void actions.runPrimary();
    else if (key === "branch" && actions.mergeState.state?.mergeState === "BEHIND")
      setBehindOpen(true);
    else if (key === "ended") props.onTab("timeline");
  };
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  // Each tab keeps its own fold: scrolled down in Code, the header stays folded there only.
  const [condensed, setCondensed] = useState<Record<PrTab, boolean>>({
    summary: false,
    timeline: false,
    code: false,
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
  const status = detail.status;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const shortcut = prShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === "summary" || shortcut === "timeline" || shortcut === "code")
      props.onTab(shortcut);
    else if (shortcut === "open")
      void openExternal(status.url).catch(() => toast.error({ title: "Couldn't open GitHub" }));
    else if (shortcut === "copy-checkout") {
      const repository = status.ref.repository;
      void navigator.clipboard
        ?.writeText(
          `gh pr checkout ${status.ref.number} --repo ${repository.host}/${repository.owner}/${repository.name}`,
        )
        .catch(() => toast.error({ title: "Couldn't copy the checkout command" }));
    } else
      event.currentTarget
        .querySelector<HTMLButtonElement>("[data-pr-primary]:not(:disabled)")
        ?.click();
  };
  const editable = !!actions.lifecycle.snapshot?.editableFields.length;
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
    />
  );
  const canRequestReview = detail.status.state === "open";
  return (
    // Shortcuts work anywhere in the panel; `contents` keeps the layout the article's.
    <div role="presentation" className="contents" onKeyDown={onKeyDown}>
      <PrReviewWorkspace
        key={JSON.stringify(detail.status.ref)}
        workspaceId={context.workspaceId}
        detail={detail}
        disabled={context.disabled}
        onRefresh={refresh}
        header={
          <div className={readable}>
            {props.page ? (
              <PrPageHeader
                actions={actions}
                extensions={props.extensions}
                behindOpen={behindOpen}
                onBehindOpen={setBehindOpen}
                gates={<PrGatesRow actions={actions} onSelect={onGate} />}
                onBack={props.onBack}
                menu={menu}
              />
            ) : (
              <PrHeader
                actions={actions}
                extensions={props.extensions}
                condensed={condensed[props.tab]}
                behindOpen={behindOpen}
                onBehindOpen={setBehindOpen}
                gates={<PrGatesRow actions={actions} onSelect={onGate} />}
                onBack={props.onBack}
                onOpen={props.onOpen}
                menu={menu}
              />
            )}
            {props.refreshFailed && (
              <p role="status" className="flex items-center gap-2 px-4 pb-1 text-xs">
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
        }
      >
        <PrTabs
          tab={props.tab}
          onTab={props.onTab}
          onScroll={onScroll}
          readable={readable}
          context={{
            summary: <SummaryContext detail={detail} />,
            timeline: (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  aria-label={`${detail.status.comments.length} comments`}
                  className="inline-flex items-center gap-1 tabular-nums"
                >
                  <ChatCircleIcon aria-hidden size={14} />
                  {detail.status.comments.length}
                </span>
                <span
                  aria-label={`${detail.commits} commits`}
                  className="inline-flex items-center gap-1 tabular-nums"
                >
                  <GitCommitIcon aria-hidden size={14} />
                  {detail.commits}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
                >
                  <ArrowsDownUpIcon aria-hidden size={14} />
                  {order === "newest" ? "Newest first" : "Oldest first"}
                </Button>
              </div>
            ),
            code: null,
          }}
          panels={{
            summary: (
              <PrSummary
                context={context}
                extensions={props.extensions}
                hostThreadId={props.hostThreadId}
                stack={actions.stack}
                refreshing={props.refreshing}
                revealChecks={revealChecks}
                onRefresh={refresh}
                onOpen={props.onOpen}
                onOpenCode={openCode}
                onRequestReview={canRequestReview ? () => setDialog("review") : undefined}
                onEdit={editable ? () => setDialog("edit") : undefined}
              />
            ),
            timeline: (
              <PrActivity workspaceId={context.workspaceId} detail={detail} order={order} />
            ),
            code: (
              <PrFiles
                workspaceId={context.workspaceId}
                repository={detail.status.ref.repository}
                detail={detail}
                context={context}
                extensions={props.extensions}
                focus={codeFocus}
              />
            ),
          }}
        />
        <PrComposer context={context} extensions={props.extensions} />
        <PrDialogs
          actions={actions}
          hostThreadId={props.hostThreadId}
          open={dialog}
          onClose={() => setDialog(undefined)}
        />
      </PrReviewWorkspace>
    </div>
  );
}

export function PrDetail(props: {
  workspaceId: string;
  repository?: ForgeRepository | undefined;
  number: number;
  /** The state the tab last saw, so the loading outline shows the number in its colour. */
  state?: ForgePrStatus["state"] | undefined;
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
  const context: PrWorkspaceContext | undefined = detail
    ? {
        workspaceId: props.workspaceId,
        detail,
        disabled:
          !fresh || unconfirmed || query.isError || refreshing || detail.writeState !== undefined,
        refresh,
      }
    : undefined;
  return (
    <article
      aria-label={`Pull request #${props.number}`}
      className="@container/pr relative flex h-full min-h-0 flex-col bg-panel"
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
        <PrGhost repository={props.repository} number={props.number} state={props.state} />
      )}
    </article>
  );
}
