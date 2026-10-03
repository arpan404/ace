import { useThreadMeta } from "@ace/client-react";
import { checkoutOf, type Checkout } from "@ace/ui-core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";

const detailsKey = (threadId: string) => ["thread", "details", threadId];
const prKey = (threadId: string) => ["thread", "pr", threadId];

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
    queryKey: [...prKey(thread.id), linked?.number],
    enabled: !thread.draft && linked !== undefined && linked !== null,
    staleTime: 60_000,
    retry: false,
    read: (_client, signal) => sources.workspace.prStatus(thread, signal),
  });
  const checkout = checkoutOf(details, pr.data);
  if (checkout) return { checkout, state: "ready" };
  const answered = details !== undefined || read.isError;
  return { checkout, state: answered ? "none" : "loading" };
}

export type GitChange =
  | { kind: "commit"; message: string; push: boolean }
  | { kind: "push" }
  | { kind: "create-pr"; title: string; summary: string; draft: boolean };

/**
 * Commit, push and open a PR. Each change reads the checkout again afterwards, so the header
 * moves to the next step from what the daemon reports rather than from a guess.
 */
export function useGitActions(thread: ThreadRef, checkout: Checkout | undefined) {
  const sources = useThreadSources();
  const queries = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (change: GitChange): Promise<number | undefined> => {
      const workspace = sources.workspace;
      if (change.kind === "commit") {
        await workspace.commit(thread, change.message, checkout?.head ?? null);
        if (change.push) await workspace.push(thread);
        return undefined;
      }
      if (change.kind === "push") {
        await workspace.push(thread);
        return undefined;
      }
      const repository = checkout?.repository;
      const branch = checkout?.branch;
      if (!repository || !branch) throw new Error("This checkout can't open a pull request.");
      // A branch without an upstream reports nothing ahead; pushing first is always safe.
      await workspace.push(thread);
      return workspace.createPr(thread, {
        repository,
        branch,
        base: checkout.baseBranch,
        title: change.title,
        summary: change.summary,
        draft: change.draft,
      });
    },
    onSettled: async () => {
      await queries.invalidateQueries({ queryKey: detailsKey(thread.id) });
      await queries.invalidateQueries({ queryKey: prKey(thread.id) });
    },
  });
  return { change: mutation.mutateAsync, pending: mutation.isPending };
}
