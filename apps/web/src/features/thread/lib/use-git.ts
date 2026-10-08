import { useThreadMeta } from "@ace/client-react";
import type { ForgePrStatus } from "@ace/protocol";
import { checkoutOf, type Checkout, type MergeMethod } from "@ace/ui-core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";

const detailsKey = (threadId: string) => ["thread", "details", threadId];
const prKey = (threadId: string) => ["thread", "pr", threadId];
const statusKey = (threadId: string) => ["thread", "git-status", threadId];
/** The state the daemon publishes in a thread's `linkedPr` for a forge status. */
const linkState = (status: ForgePrStatus) =>
  status.state === "draft" || status.state === "unknown" ? "open" : status.state;

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
 * and a linked PR's status is a one-off forge read.
 */
export function useCheckout(thread: ThreadRef): Checkout | undefined {
  return useCheckoutState(thread).checkout;
}

/**
 * The checkout with how far its read got: `loading` until the daemon has answered, `none` when
 * it answered and the thread's directory isn't a git checkout (or the read failed).
 */
export function useCheckoutState(thread: ThreadRef): {
  checkout: Checkout | undefined;
  /** The linked PR as the forge last reported it (checks, mergeability, review threads). */
  status: ForgePrStatus | undefined;
  state: "loading" | "ready" | "none";
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
  const linked = details?.linkedPr;
  const pr = useDaemonQuery({
    // The daemon publishes the link's state as the forge reports it (merged by auto-merge,
    // closed on GitHub): a change reads the full status again.
    queryKey: [...prKey(thread.id), linked?.number, linked?.state],
    enabled: !thread.draft && linked !== undefined && linked !== null,
    staleTime: 60_000,
    retry: false,
    read: (_client, signal) => sources.workspace.prStatus(thread, signal),
  });
  const checkout = checkoutOf(details, pr.data);
  const status = pr.data ?? undefined;
  if (checkout) return { checkout, status, state: "ready" };
  const answered = details !== undefined || read.isError;
  return { checkout, status, state: answered ? "none" : "loading" };
}

export type GitChange =
  | {
      kind: "commit";
      message: string;
      push: boolean;
      /** The files picked (a rename names both paths); every change when absent. */
      paths?: readonly string[];
    }
  | { kind: "push" }
  | {
      kind: "create-pr";
      title: string;
      summary: string;
      draft: boolean;
      /** GitHub usernames to ask for review once it is open. */
      reviewers?: readonly string[];
    }
  | { kind: "link-pr"; number: number }
  /** Merge the head the person saw (`headSha`): the forge refuses if the branch moved since. */
  | { kind: "merge"; method: MergeMethod; auto: boolean; headSha: string }
  | { kind: "request-review"; reviewers: readonly string[] };

/**
 * Commit, push, open or link a PR, and act on the linked one. Each change reads the checkout
 * again afterwards, so the header moves to the next step from what the daemon reports rather
 * than from a guess; a forge action's answer is the PR's fresh status.
 */
export function useGitActions(thread: ThreadRef, checkout: Checkout | undefined) {
  const sources = useThreadSources();
  const queries = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (change: GitChange): Promise<ForgePrStatus | undefined> => {
      const workspace = sources.workspace;
      if (change.kind === "commit") {
        await workspace.commit(thread, change.message, checkout?.head ?? null, change.paths);
        if (change.push) await workspace.push(thread);
        return undefined;
      }
      if (change.kind === "push") {
        await workspace.push(thread);
        return undefined;
      }
      const repository = checkout?.repository;
      if (!repository) throw new Error("This checkout has no GitHub remote.");
      const published = (status: ForgePrStatus) => {
        queries.setQueryData([...prKey(thread.id), status.ref.number, linkState(status)], status);
        return status;
      };
      if (change.kind === "link-pr")
        return published(await workspace.linkPr(thread, { repository, number: change.number }));
      if (change.kind === "create-pr") {
        const branch = checkout.branch;
        if (!branch) throw new Error("This checkout can't open a pull request.");
        // A branch without an upstream reports nothing ahead; pushing first is always safe.
        await workspace.push(thread);
        const status = await workspace.createPr(thread, {
          repository,
          branch,
          base: checkout.baseBranch,
          title: change.title,
          summary: change.summary,
          draft: change.draft,
        });
        published(status);
        return change.reviewers?.length
          ? published(await workspace.requestReview(thread, status.ref, change.reviewers))
          : status;
      }
      const pr = checkout.pr && { repository, number: checkout.pr.number };
      if (!pr) throw new Error("No pull request is linked to this thread.");
      if (change.kind === "request-review")
        return published(await workspace.requestReview(thread, pr, change.reviewers));
      return published(
        await workspace.mergePr(thread, pr, {
          headSha: change.headSha,
          method: change.method,
          auto: change.auto,
        }),
      );
    },
    onSettled: async (_status, error, change) => {
      await queries.invalidateQueries({ queryKey: detailsKey(thread.id) });
      await queries.invalidateQueries({ queryKey: statusKey(thread.id) });
      // A commit or push moves the PR's head; a refused forge action may mean it changed.
      if (error || change.kind === "commit" || change.kind === "push")
        await queries.invalidateQueries({ queryKey: prKey(thread.id) });
    },
  });
  /** Ask the forge for the linked PR's status now; failures leave the last one shown. */
  const refreshPr = async () => {
    const repository = checkout?.repository;
    const number = checkout?.pr?.number;
    if (!repository || number === undefined) return;
    const status = await sources.workspace.refreshPr(thread, { repository, number });
    queries.setQueryData([...prKey(thread.id), number, linkState(status)], status);
  };
  return { change: mutation.mutateAsync, pending: mutation.isPending, refreshPr };
}
