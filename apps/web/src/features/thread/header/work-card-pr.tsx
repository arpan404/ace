import type { CheckoutPr } from "@ace/ui-core";
import { mergeGate, mergeMethods, type MergeMethod } from "@ace/ui-core";
import { useMergeMethod } from "./merge-method.ts";
import { useState } from "react";
import { pullRequestTab } from "@/features/panels/index.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { WorkspaceError } from "../sources/workspace-source.ts";
import { failure, type useGitFlow } from "./use-git-flow.tsx";
import { RowAction, RowStatic, RowSub } from "./work-card-parts.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const checks: Partial<Record<NonNullable<CheckoutPr["ci"]>, string>> = {
  success: "checks passed",
  failure: "checks failing",
  pending: "checks running",
  unknown: "checks unavailable",
};

/** Why the PR's state may be stale, in the card's words. */
const problems: Record<NonNullable<GitFlow["prProblem"]>, string> = {
  unverified: "couldn't verify with GitHub",
  deleted: "repository deleted",
  unreadable: "couldn't read from GitHub",
};

/** "open · checks passed", in words a screen reader hears too. */
export function prSummary(pr: CheckoutPr, problem?: GitFlow["prProblem"]): string {
  if (problem) return `${pr.state} · ${problems[problem]}`;
  const ci = pr.ci && checks[pr.ci];
  return ci ? `${pr.state} · ${ci}` : pr.state;
}

/**
 * The thread's pull request on one line: `#214 open · checks passed · Merge`. The number opens
 * the PR in the thread's side panel; Merge reads the PR again, then asks before merging, as
 * every merge does. When the forge's last answer says it can't merge, Merge is off and the
 * reason shows under the line.
 */
export function PrLine(props: {
  git: GitFlow;
  threadId: string;
  workspaceId: string;
  onClose(): void;
}) {
  const { git } = props;
  const pr = git.checkout?.pr;
  const panel = useWorkspaceActions(props.threadId);
  const method = useMergeMethod();
  const { merge, checking } = useMergePr(git);
  if (!pr) return null;
  const repository = pr.repo ?? git.checkout?.repository;
  const live = pr.state === "open" || pr.state === "draft";
  const same = git.status?.ref.number === pr.number;
  const gate = git.status && same ? mergeGate(git.status, git.checkout?.baseBranch) : undefined;
  const summary = prSummary(pr, git.prProblem);
  return (
    <>
      <RowStatic label={`Pull request #${pr.number}`} className="hover:bg-accent">
        <PullRequestGlyph state={pr.state} size={16} />
        <button
          type="button"
          className="focus-ring min-w-0 shrink-0 rounded-sm text-left"
          aria-label={`Open pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, ${summary}`}
          title={pr.title}
          disabled={!repository}
          onClick={() => {
            if (!repository) return;
            props.onClose();
            panel.open(
              pullRequestTab({ workspaceId: props.workspaceId, repository, number: pr.number }),
            );
          }}
        >
          #{pr.number}
        </button>
        <RowSub aria-hidden className="flex-1">
          {checking ? "checking…" : summary}
        </RowSub>
        {live && (
          <RowAction
            disabled={git.pending || checking || !!gate || !repository || pr.deleted === true}
            aria-label={`Merge pull request #${pr.number}`}
            title={mergeMethods.find((each) => each.method === method)?.label}
            onClick={() => void merge(method)}
          >
            Merge
          </RowAction>
        )}
      </RowStatic>
      {live && gate && (
        <p className="mx-2 mb-1 pl-7 text-xs text-muted-foreground">Can't merge: {gate}</p>
      )}
    </>
  );
}

/**
 * Merging the thread's pull request with `method`: read the PR again, say why when it can't be
 * merged, else ask before merging, as every merge does. A merge that goes through makes its
 * method the next one's default (`useGitFlow`); a blocked or cancelled one leaves it.
 */
export function useMergePr(git: GitFlow): {
  merge(method: MergeMethod): Promise<void>;
  checking: boolean;
} {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const pr = git.checkout?.pr;
  const repository = pr?.repo ?? git.checkout?.repository;
  const base = git.checkout?.baseBranch;
  const merge = async (method: MergeMethod) => {
    if (!pr || !repository || checking || git.pending) return;
    setChecking(true);
    try {
      const status = await git.refreshPr({ repository, number: pr.number });
      if (!status) throw new WorkspaceError("pr_unreadable");
      const blocked = mergeGate(status, base);
      if (blocked) return void toast.error({ title: blocked });
      git.run({ kind: "merge", method, auto: false, headSha: status.headSha, pr: status.ref });
    } catch (error) {
      toast.error({ title: "Couldn't merge", description: failure(error) });
    } finally {
      setChecking(false);
    }
  };
  return { merge, checking };
}
