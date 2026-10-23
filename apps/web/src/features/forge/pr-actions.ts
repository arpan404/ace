import {
  ciLine,
  mergeGate,
  noAutoMerge,
  prPrimaryAction,
  mergeBlockers,
  prGates,
} from "@ace/ui-core";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { usePrLifecycle } from "./pr-lifecycle.ts";
import { usePrMergeState } from "./pr-merge-state.ts";
import { usePrLinkWrites } from "./pr-link-writes.ts";
import { usePrWorktree } from "./pr-worktree.ts";
import { useMergeMethod } from "./pr-merge-method.ts";
import { useStackMemberships } from "./pr-stack-groups.tsx";
import { useFollowPrReviewers, useReviewOutcomes } from "./pr-reviewers-query.ts";
import { usePrLocalCheck } from "./pr-local-check.ts";

const newCommandId = () => crypto.randomUUID();

/**
 * Every write the PR panel offers, gathered once so the header's primary control, the ⋯ menu
 * and the result strip read the same state and the same fences.
 */
export function usePrActions(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  /** The task whose side panel shows this PR, when there is one. */
  hostThreadId?: string | undefined;
  /** Opens the panel's own conflict view; GitHub's conflict page when there is none. */
  openConflicts?: (() => void) | undefined;
  /** Opens the commit title and message before a merge or squash, now or on auto-merge. */
  editCommit?: ((when: "now" | "auto") => void) | undefined;
}) {
  const { context } = props;
  const openWeb = useOpenWebAddress();
  const { detail, workspaceId } = context;
  const { status } = detail;
  const related = detail.relatedThreads;
  // Writes go through the task showing the PR when it's linked, else the first linked task.
  const threadId = (related.find((t) => t.id === props.hostThreadId) ?? related[0])?.id;
  const [method, setMethod] = useMergeMethod(workspaceId);
  const onRefresh = () => void context.refresh();
  const lifecycle = usePrLifecycle({
    workspaceId,
    detail,
    writeDisabled: context.disabled,
    onRefresh,
  });
  const mergeState = usePrMergeState({
    workspaceId,
    detail,
    threadId,
    projectWrites: threadId === undefined && props.hostThreadId === undefined,
    writeDisabled: context.disabled,
    onRefresh,
  });
  // Outside a thread (the Pull requests page) a PR merges through its project, linked or not.
  const projectMerge = threadId === undefined && props.hostThreadId === undefined;
  const writes = usePrLinkWrites({
    detail,
    threadId,
    workspaceId,
    writeReady: !context.disabled,
    onRefresh: context.refresh,
  });
  const worktree = usePrWorktree({ workspaceId, detail, newId: newCommandId, onRefresh });
  const membership = useStackMemberships(workspaceId, status.ref.repository, [status.ref.number]);
  const stack = membership.isError ? undefined : (membership.data?.[0]?.stack ?? undefined);
  const local = usePrLocalCheck(workspaceId, status);
  // The PR view is mounted whichever tab shows: here the reviewers follow the PR, so the gates
  // and the merge button never read a verdict older than the PR itself.
  useFollowPrReviewers(workspaceId, detail);
  const outcomes = useReviewOutcomes(workspaceId, detail);
  // The same gates the header shows decide whether a merge is blocked.
  const blockers = mergeBlockers(
    prGates({
      status,
      reviewDecision: detail.reviewDecision,
      mergeState: mergeState.state,
      baseBranch: detail.baseBranch,
      outcomes,
      local: local.result,
    }),
  );
  const primary = prPrimaryAction({
    status,
    mergeState: mergeState.state,
    method,
    linked: threadId !== undefined || projectMerge,
    autoMerge: threadId !== undefined || projectMerge,
    blockers,
  });
  const host = props.hostThreadId;
  const linkReason =
    threadId || projectMerge ? undefined : "Link this pull request to a task first";
  const fenceReason = writes.fenced
    ? "Refresh GitHub to confirm the previous change first"
    : context.disabled || writes.pending
      ? "Wait for GitHub to refresh"
      : undefined;
  // The work card asks the same gate, so both say the same thing about this PR.
  const gate = mergeGate(status, detail.baseBranch);
  // Waiting on checks is what auto-merge is for: where GitHub won't arm it, say so instead.
  const noAuto =
    gate !== undefined &&
    ciLine(status).tone === "pending" &&
    mergeState.state !== undefined &&
    !mergeState.state.canEnable &&
    !mergeState.state.autoMerge;
  const mergeBlocked =
    (noAuto ? `Checks are still running. ${noAutoMerge}` : gate) ??
    membership.mergeBlocker ??
    linkReason ??
    fenceReason ??
    (status.state === "open" ? undefined : "The pull request isn't open");
  const autoMergeBlocked = mergeState.enableBlocked ?? membership.mergeBlocker;
  const readyBlocked = !lifecycle.can("ready")
    ? "GitHub doesn't let this account mark it ready"
    : lifecycle.blocked
      ? "Wait for GitHub to refresh"
      : undefined;
  const resolveConflicts = () => {
    if (props.extensions?.resolveInWorktree) props.extensions.resolveInWorktree(context);
    else if (props.openConflicts) props.openConflicts();
    else void openWeb(`${status.url}/conflicts`).catch(() => {});
  };
  /** Merge now: a merge or squash first shows its commit to edit; a rebase writes none. */
  const merge = () => {
    if (method !== "rebase" && props.editCommit) return props.editCommit("now");
    return writes.merge(method);
  };
  /** Turn auto-merge on, with its commit to edit first for a merge or squash. */
  const enableAutoMerge = () => {
    if (method !== "rebase" && props.editCommit) return props.editCommit("auto");
    return mergeState.run("enable", method);
  };
  return {
    context,
    threadId,
    method,
    setMethod,
    lifecycle,
    mergeState,
    writes,
    worktree,
    stack,
    /** The latest local check of the head, counted in the checks gate. */
    local,
    primary,
    mergeBlocked,
    autoMergeBlocked,
    readyBlocked,
    /** Why the primary control can't act now, or undefined when it can. */
    primaryBlocked:
      primary.kind === "merge"
        ? mergeBlocked
        : primary.kind === "auto-merge" || primary.kind === "auto-merge-ready"
          ? autoMergeBlocked
          : primary.kind === "blocked"
            ? primary.blockers.join("\n")
            : primary.kind === "link"
              ? host
                ? writes.pending || context.disabled
                  ? "Wait for GitHub to refresh"
                  : undefined
                : "Link this pull request to a task from the ⋯ menu"
              : primary.kind === "ready"
                ? readyBlocked
                : primary.kind === "resolve" &&
                    props.extensions?.resolveInWorktree &&
                    context.disabled
                  ? "Wait for GitHub to refresh"
                  : undefined,
    merge,
    enableAutoMerge,
    /** A merge or auto-merge from here first shows its commit to edit and confirm. */
    editsCommit: method !== "rebase" && props.editCommit !== undefined,
    async runPrimary() {
      if (primary.kind === "merge") return merge();
      if (primary.kind === "auto-merge" || primary.kind === "auto-merge-ready")
        return enableAutoMerge();
      if (primary.kind === "link" && host) return writes.link(host);
      if (primary.kind === "ready") return void (await lifecycle.apply({ kind: "ready" }));
      if (primary.kind === "resolve") resolveConflicts();
    },
    /** Read everything again; a deliberate read also settles fenced writes. */
    async refresh() {
      const [ok] = await Promise.all([
        writes.fenced ? writes.reconcile() : context.refresh(),
        mergeState.confirm(),
      ]);
      return ok;
    },
  };
}
export type PrActions = ReturnType<typeof usePrActions>;
