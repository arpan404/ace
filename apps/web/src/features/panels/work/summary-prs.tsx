import { DiffCounts } from "@/components/diff-stat.tsx";
import type { ForgePrDetail, LinkedPullRequest } from "@ace/protocol";
import { pluralCount } from "@ace/ui-core";
import { GitPullRequestIcon, XIcon } from "@phosphor-icons/react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { usePrPrefetch, prDetailKey } from "@/lib/forge-pr-detail.ts";
import { pullRequestTab, useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { PrUnlinkDialog } from "./pr-unlink-dialog.tsx";
import { useUnlinkPr } from "./pr-unlink.ts";

const stateWords: Record<LinkedPullRequest["state"], string> = {
  open: "In review",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const ciWords = {
  none: "No checks",
  pending: "Checks running",
  success: "Checks passed",
  failure: "Checks failed",
  unknown: "",
} as const;

/** A result row's frame: a quiet kind icon, then its title over one grey line. */
export const resultRow = "flex min-w-0 items-start gap-2.5 py-1.5";
export const resultIcon = "mt-0.5 shrink-0 text-subtle-foreground";

/**
 * One pull request: its title, then number, state and, once its detail has been read for the PR
 * panel, its checks and size. The Summary never reads the forge itself for this line.
 */
function PrRow(props: {
  threadId: string;
  workspaceId: string;
  pr: LinkedPullRequest;
  onUnlink(): void;
}) {
  const { pr } = props;
  const actions = useWorkspaceActions(props.threadId);
  const prefetch = usePrPrefetch(props.workspaceId);
  const detail = useQuery<ForgePrDetail>({
    queryKey: prDetailKey(props.workspaceId, pr.repo, pr.number),
    // Read from the cache only: the PR panel reads the forge, the Summary never does.
    queryFn: skipToken,
  }).data;
  const ci = detail ? ciWords[detail.status.ci] : "";
  const sized = detail?.additions !== undefined && detail.deletions !== undefined;
  return (
    <li className={`group/pr ${resultRow}`}>
      <GitPullRequestIcon aria-hidden size={14} className={resultIcon} />
      <button
        type="button"
        title={pr.title}
        aria-label={`Pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, ${stateWords[pr.state].toLowerCase()}`}
        onPointerEnter={() => prefetch(pr.repo, pr.number)}
        onFocus={() => prefetch(pr.repo, pr.number)}
        onClick={() =>
          actions.open(
            pullRequestTab({
              workspaceId: props.workspaceId,
              repository: pr.repo,
              number: pr.number,
            }),
          )
        }
        className="focus-ring-inset min-w-0 flex-1 rounded-sm text-left"
      >
        <span className="block truncate text-ui font-medium">{pr.title ?? `#${pr.number}`}</span>
        <span className="block truncate text-xs text-subtle-foreground tabular-nums">
          {[`#${pr.number}`, stateWords[pr.state], ci].filter(Boolean).join(" · ")}
          {sized && (
            <>
              {" · "}
              <DiffCounts additions={detail.additions ?? 0} deletions={detail.deletions ?? 0} />
            </>
          )}
        </span>
      </button>
      <IconButton
        icon={XIcon}
        label={`Unlink pull request #${pr.number}`}
        size="sm"
        onClick={props.onUnlink}
        className="hidden group-focus-within/pr:inline-grid group-hover/pr:inline-grid pointer-coarse:inline-grid"
      />
    </li>
  );
}

/**
 * The thread's pull requests, in review first; closed ones fold into one quiet line that opens
 * them. Each opens in the side panel; × unlinks it from the thread after asking.
 */
export function PrResults(props: {
  threadId: string;
  workspaceId: string;
  prs: readonly LinkedPullRequest[];
}) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const sections = workspace.tabs.find((tab) => tab.key === "work")?.ui?.sections;
  const showClosed = sections?.["prs:closed"] === true;
  const unlinkPr = useUnlinkPr(props.threadId);
  const [unlink, setUnlink] = useState<LinkedPullRequest | undefined>();
  const current = props.prs.filter((pr) => pr.state !== "closed");
  const closed = props.prs.filter((pr) => pr.state === "closed");
  const rows = showClosed ? [...current, ...closed] : current;
  return (
    <>
      {rows.map((pr) => (
        <PrRow
          key={`${pr.repo.owner}/${pr.repo.name}#${pr.number}`}
          threadId={props.threadId}
          workspaceId={props.workspaceId}
          pr={pr}
          onUnlink={() => setUnlink(pr)}
        />
      ))}
      {closed.length > 0 && (
        <li>
          <button
            type="button"
            aria-expanded={showClosed}
            onClick={() =>
              actions.updateUi("work", { sections: { ...sections, "prs:closed": !showClosed } })
            }
            className="focus-ring-inset rounded-sm py-1 text-xs text-subtle-foreground hover:text-foreground"
          >
            {showClosed
              ? "Hide closed pull requests"
              : `${pluralCount(closed.length, "earlier pull request")}, closed`}
          </button>
        </li>
      )}
      {unlink && (
        <PrUnlinkDialog
          number={unlink.number}
          onClose={() => setUnlink(undefined)}
          onUnlink={() => unlinkPr({ number: unlink.number, repo: unlink.repo })}
        />
      )}
    </>
  );
}
