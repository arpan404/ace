import { useThreadMeta } from "@ace/client-react";
import type { ForgePrStatus, ThreadDetails } from "@ace/protocol";
import { checkoutOf, prPollInterval, type Checkout } from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { gitFailureCode } from "./git-failure.ts";
import { detailsKey, prKey, repositoryKey, statusKey } from "./query-keys.ts";

export { useGitActions, type GitChange, type GitResult } from "./use-git-actions.ts";

/**
 * The files a commit of the checkout would take, read fresh each time a commit form opens:
 * exactly what `git status` reports, untracked files included.
 */
export function useChangedFiles(thread: ThreadRef, enabled = true) {
  const sources = useThreadSources();
  return useDaemonQuery({
    queryKey: statusKey(thread.id),
    enabled: enabled && !thread.draft,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    read: (_client, signal) => sources.workspace.gitStatus(thread, signal),
  });
}

/**
 * The thread checkout's git and PR state. Details are live thread state (the daemon publishes
 * every refresh into the thread); opening the thread asks the daemon to read the checkout again,
 * and a linked PR's status is a forge read.
 */
export function useCheckout(thread: ThreadRef): Checkout | undefined {
  return useCheckoutState(thread).checkout;
}

/**
 * Why the linked PR's state may be stale: the daemon couldn't verify the link with GitHub, the
 * PR's repository is gone, or the forge read failed.
 */
export type PrProblem = "unverified" | "deleted" | "unreadable";

/**
 * The checkout with how far its read got: `loading` until the daemon has answered, `none` when
 * it answered and the thread's directory isn't a git checkout, `error` when the read failed (with
 * the daemon's code, and `retry` to read again).
 */
export function useCheckoutState(thread: ThreadRef): {
  checkout: Checkout | undefined;
  /** The linked PR as the forge last reported it (checks, mergeability, review threads). */
  status: ForgePrStatus | undefined;
  state: "loading" | "ready" | "none" | "error";
  /** The refusal code of a failed checkout read. */
  error: string | undefined;
  retry(): void;
  prProblem: PrProblem | undefined;
  linkedPrs: ThreadDetails["linkedPrs"];
} {
  const sources = useThreadSources();
  const live = useThreadMeta(thread.id)?.details;
  const read = useDaemonQuery({
    queryKey: detailsKey(thread.id),
    enabled: !thread.draft,
    staleTime: 30_000,
    retry: false,
    read: (_client, signal) => sources.workspace.details(thread, signal),
  });
  const details = live ?? read.data;
  const linked = details?.linkedPrs?.[0];
  const pr = useDaemonQuery<ForgePrStatus | null>({
    // The daemon publishes the link's state as the forge reports it (merged by auto-merge,
    // closed on GitHub): a change reads the full status again.
    queryKey: [...prKey(thread.id), ...repositoryKey(linked?.repo), linked?.number, linked?.state],
    enabled: !thread.draft && linked !== undefined,
    staleTime: 60_000,
    retry: false,
    // While checks run or GitHub is still computing mergeability, read again on its own: the
    // PR panel polls on the same rule, so the two never disagree for long.
    refetchInterval: (query) => prPollInterval(query.state.data),
    read: (_client, signal) => sources.workspace.prStatus(thread, signal),
  });
  const checkout = checkoutOf(details, pr.data);
  const status = pr.data ?? undefined;
  const prProblem: PrProblem | undefined = linked?.deleted
    ? "deleted"
    : pr.isError
      ? "unreadable"
      : linked?.unverified
        ? "unverified"
        : undefined;
  const common = {
    checkout,
    status,
    prProblem,
    linkedPrs: details?.linkedPrs,
    retry: () => void read.refetch(),
  };
  if (checkout) return { ...common, state: "ready", error: undefined };
  if (details !== undefined) return { ...common, state: "none", error: undefined };
  if (read.isError) return { ...common, state: "error", error: gitFailureCode(read.error) };
  return { ...common, state: "loading", error: undefined };
}
