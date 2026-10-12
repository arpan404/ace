import type { CheckoutPr } from "@ace/ui-core";
import { prOverview } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failure, type useGitFlow } from "./use-git-flow.tsx";
import { RowAction, RowStatic, RowSub } from "./work-card-parts.tsx";

type GitFlow = ReturnType<typeof useGitFlow>;

const checks: Partial<Record<NonNullable<CheckoutPr["ci"]>, string>> = {
  success: "checks passed",
  failure: "checks failing",
  pending: "checks running",
};

/** "open · checks passed", in words a screen reader hears too. */
export function prSummary(pr: CheckoutPr): string {
  const ci = pr.ci && checks[pr.ci];
  return ci ? `${pr.state} · ${ci}` : pr.state;
}

/**
 * The thread's pull request on one line: `#214 open · checks passed · Merge`. The number opens
 * the PR workspace; Merge reads the PR again, then asks before merging, as every merge does.
 */
export function PrLine(props: { git: GitFlow; workspaceId: string; onClose(): void }) {
  const { git } = props;
  const pr = git.checkout?.pr;
  const navigate = useNavigate();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  if (!pr) return null;
  const repository = pr.repo ?? git.checkout?.repository;
  const base = git.checkout?.baseBranch ?? "main";
  const live = pr.state === "open" || pr.state === "draft";
  const merge = async () => {
    if (!repository || checking || git.pending) return;
    setChecking(true);
    try {
      const status = await git.refreshPr({ repository, number: pr.number });
      if (!status) throw new Error("Couldn't read the pull request");
      const blocked = prOverview(status, base).mergeBlocked;
      if (blocked) return void toast.error({ title: blocked });
      git.run({
        kind: "merge",
        method: "squash",
        auto: false,
        headSha: status.headSha,
        pr: status.ref,
      });
    } catch (error) {
      toast.error({ title: "Couldn't merge", description: failure(error) });
    } finally {
      setChecking(false);
    }
  };
  return (
    <RowStatic label={`Pull request #${pr.number}`} className="hover:bg-accent">
      <PullRequestGlyph state={pr.state} size={16} />
      <button
        type="button"
        className="focus-ring min-w-0 shrink-0 rounded-sm text-left"
        aria-label={`Open pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, ${prSummary(pr)}`}
        title={pr.title}
        disabled={!repository}
        onClick={() => {
          if (!repository) return;
          props.onClose();
          void navigate({
            to: "/pull-requests",
            search: {
              project: props.workspaceId,
              repo: `${repository.host}/${repository.owner}/${repository.name}`,
              number: pr.number,
            },
          });
        }}
      >
        #{pr.number}
      </button>
      <RowSub aria-hidden className="flex-1">
        {checking ? "checking…" : prSummary(pr)}
      </RowSub>
      {live && (
        <RowAction
          disabled={git.pending || checking || pr.state === "draft" || !repository}
          aria-label={`Merge pull request #${pr.number}`}
          title={pr.state === "draft" ? "Mark this PR ready on GitHub before merging" : undefined}
          onClick={() => void merge()}
        >
          Merge
        </RowAction>
      )}
    </RowStatic>
  );
}
