import type { ForgePrRef, ForgePrStatus, ForgeRepository } from "@ace/protocol";
import type { Checkout, MergeMethod } from "@ace/ui-core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { WorkspaceError, type ForceLease } from "../sources/workspace-source.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { detailsKey, linkState, prKey, repositoryKey, statusKey } from "./query-keys.ts";

export type GitChange =
  | {
      kind: "commit";
      message: string;
      push: boolean;
      /** The files picked (a rename names both paths); every change when absent. */
      paths?: readonly string[];
      /**
       * The HEAD `git status` reported with those files, so a commit made meanwhile (in a
       * terminal) is refused rather than guessed from older thread details.
       */
      head?: string | null | undefined;
      draftFingerprint?: string | undefined;
    }
  /** With `force`, overwrite the remote branch only while it still holds `force.lease`. */
  | { kind: "push"; force?: ForceLease }
  | {
      kind: "create-pr";
      title: string;
      draftFingerprint?: string | undefined;
      summary: string;
      draft: boolean;
      /** GitHub usernames to ask for review once it is open. */
      reviewers?: readonly string[];
    }
  | { kind: "link-pr"; number: number; repository?: ForgeRepository }
  | { kind: "unlink-pr"; number?: number; repo?: ForgeRepository; all?: true }
  /** Merge the head the person saw (`headSha`): the forge refuses if the branch moved since. */
  | { kind: "merge"; method: MergeMethod; auto: boolean; headSha: string; pr?: ForgePrRef }
  | { kind: "request-review"; reviewers: readonly string[] };

/** What the daemon answered for a change that went through, at least in part. */
export interface GitResult {
  /** A forge action's answer: the PR's fresh status. */
  status?: ForgePrStatus | undefined;
  /** Create PR linked the branch's existing pull request instead of opening one. */
  existing?: boolean;
  /** The commit a commit change made. */
  commit?: string | undefined;
  /**
   * A later step failed after an earlier one took effect: the commit is made but its push
   * failed, or the PR is open but asking for review failed. Retrying must redo only `step`.
   */
  partial?: { step: "push" | "review-request"; error: unknown };
}

/**
 * Commit, push, open or link a PR, and act on the linked one. Each change reads the checkout
 * again afterwards, so the header moves to the next step from what the daemon reports rather
 * than from a guess; a forge action's answer is the PR's fresh status.
 */
export function useGitActions(thread: ThreadRef, checkout: Checkout | undefined) {
  const sources = useThreadSources();
  const queries = useQueryClient();
  const published = (status: ForgePrStatus) => {
    queries.setQueryData(
      [
        ...prKey(thread.id),
        ...repositoryKey(status.ref.repository),
        status.ref.number,
        linkState(status),
      ],
      status,
    );
    return status;
  };
  const mutation = useMutation({
    mutationKey: ["thread", thread.id, "git-change"],
    mutationFn: async (change: GitChange): Promise<GitResult> => {
      const workspace = sources.workspace;
      if (change.kind === "commit") {
        const commit = await workspace.commit(
          thread,
          change.message,
          change.head !== undefined ? change.head : (checkout?.head ?? null),
          change.paths,
          change.draftFingerprint,
        );
        if (!change.push) return { commit };
        try {
          await workspace.push(thread);
        } catch (error) {
          return { commit, partial: { step: "push", error } };
        }
        return { commit };
      }
      if (change.kind === "push") {
        await workspace.push(thread, undefined, change.force);
        return {};
      }
      if (change.kind === "unlink-pr") {
        await workspace.unlinkPr(
          thread,
          change.all
            ? { all: true }
            : {
                number: change.number ?? checkout?.pr?.number ?? 0,
                ...(change.repo ? { repo: change.repo } : {}),
              },
        );
        queries.removeQueries({ queryKey: prKey(thread.id) });
        return {};
      }
      const repository =
        change.kind === "link-pr"
          ? (change.repository ?? checkout?.repository)
          : change.kind === "merge" && change.pr
            ? change.pr.repository
            : checkout?.repository;
      if (!repository) throw new WorkspaceError("forge_no_remote");
      if (change.kind === "link-pr")
        return {
          status: published(
            await workspace.linkPr(thread, {
              repository: change.repository ?? repository,
              number: change.number,
            }),
          ),
        };
      if (!checkout) throw new WorkspaceError("pr_unavailable");
      if (change.kind === "create-pr") return createPr(change, checkout, repository);
      const pr =
        (change.kind === "merge" && change.pr) ||
        (checkout.pr && {
          repository: checkout.pr.repo ?? repository,
          number: checkout.pr.number,
        });
      if (!pr) throw new WorkspaceError("pr_not_linked");
      if (change.kind === "request-review")
        return { status: published(await workspace.requestReview(thread, pr, change.reviewers)) };
      return {
        status: published(
          await workspace.mergePr(thread, pr, {
            headSha: change.headSha,
            method: change.method,
            auto: change.auto,
          }),
        ),
      };
    },
    onSettled: async (_result, error, change) => {
      await queries.invalidateQueries({ queryKey: detailsKey(thread.id) });
      await queries.invalidateQueries({ queryKey: statusKey(thread.id) });
      // A commit or push moves the PR's head; a refused forge action may mean it changed.
      if (error || change.kind === "commit" || change.kind === "push")
        await queries.invalidateQueries({ queryKey: prKey(thread.id) });
    },
  });
  const createPr = async (
    change: Extract<GitChange, { kind: "create-pr" }>,
    at: Checkout,
    repository: ForgeRepository,
  ): Promise<GitResult> => {
    const workspace = sources.workspace;
    const branch = at.branch;
    if (!branch) throw new WorkspaceError("pr_unavailable");
    if (change.draftFingerprint) {
      const context = await workspace.draftContext(thread, {
        kind: "pr",
        branch,
        base: at.baseBranch,
        ...(at.baseRef ? { baseRef: at.baseRef } : {}),
      });
      if (context.fingerprint !== change.draftFingerprint)
        throw new WorkspaceError("draft_changes_moved");
    }
    // A branch without an upstream reports nothing ahead; pushing first is always safe.
    await workspace.push(thread, { repository, branch, head: at.head });
    const { status, existing } = await workspace.createPr(thread, {
      repository,
      branch,
      base: at.baseBranch,
      title: change.title,
      draftFingerprint: change.draftFingerprint,
      draftBaseRef: at.baseRef,
      summary: change.summary,
      draft: change.draft,
      ...(at.head ? { expectedHead: at.head } : {}),
    });
    published(status);
    if (!change.reviewers?.length) return { status, existing };
    try {
      return {
        status: published(await workspace.requestReview(thread, status.ref, change.reviewers)),
        existing,
      };
    } catch (error) {
      // The PR is open either way: report what happened, not a failure to open it.
      return { status, existing, partial: { step: "review-request", error } };
    }
  };
  /** Ask the forge for the linked PR's status now; failures leave the last one shown. */
  const refreshPr = async (pr?: ForgePrRef) => {
    const repository = pr?.repository ?? checkout?.pr?.repo ?? checkout?.repository;
    const number = pr?.number ?? checkout?.pr?.number;
    if (!repository || number === undefined) return;
    return published(await sources.workspace.refreshPr(thread, { repository, number }));
  };
  return { change: mutation.mutateAsync, pending: mutation.isPending, refreshPr };
}
