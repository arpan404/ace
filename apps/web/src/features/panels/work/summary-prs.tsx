import type { LinkedPullRequest } from "@ace/protocol";
import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { usePrPrefetch } from "@/lib/forge-pr-detail.ts";
import { pullRequestTab, useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { PrUnlinkDialog } from "./pr-unlink-dialog.tsx";
import { useUnlinkPr } from "./pr-unlink.ts";
import { QuietLink, Section } from "./summary-section.tsx";

export const prStateWords: Record<LinkedPullRequest["state"], string> = {
  open: "In review",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** One pull request in one line: its number and title, its state at the right; × unlinks it. */
function PrRow(props: {
  threadId: string;
  workspaceId: string;
  pr: LinkedPullRequest;
  onUnlink(): void;
}) {
  const { pr } = props;
  const actions = useWorkspaceActions(props.threadId);
  const prefetch = usePrPrefetch(props.workspaceId);
  return (
    <li className="group/pr flex min-w-0 items-center rounded-md hover:bg-accent">
      <button
        type="button"
        title={pr.title}
        aria-label={`Pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, ${prStateWords[pr.state].toLowerCase()}`}
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
        className="focus-ring-inset flex h-7.5 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-ui pointer-coarse:h-11"
      >
        <span className="shrink-0 text-subtle-foreground tabular-nums">#{pr.number}</span>
        <span className="min-w-0 flex-1 truncate">{pr.title}</span>
        <span className="shrink-0 text-xs text-subtle-foreground group-focus-within/pr:hidden group-hover/pr:hidden">
          {prStateWords[pr.state]}
        </span>
      </button>
      <IconButton
        icon={XIcon}
        label={`Unlink pull request #${pr.number}`}
        size="sm"
        onClick={props.onUnlink}
        className="mr-0.5 hidden group-focus-within/pr:inline-grid group-hover/pr:inline-grid pointer-coarse:inline-grid"
      />
    </li>
  );
}

/** "24 merged · 2 closed": how many settled pull requests fold into the quiet line. */
function settledWords(prs: readonly LinkedPullRequest[]) {
  const merged = prs.filter((pr) => pr.state === "merged").length;
  const closed = prs.length - merged;
  return [merged && `${merged} merged`, closed && `${closed} closed`].filter(Boolean).join(" · ");
}

/**
 * The thread's other pull requests, beside the one the outcome leads with: open and draft ones
 * as one-line rows, merged and closed ones folded into one quiet line ("24 merged · Show") that
 * opens them in place; the choice is kept with the tab. Each opens in the side panel; × unlinks
 * it from the thread after asking.
 */
export function OtherPullRequests(props: {
  threadId: string;
  workspaceId: string;
  prs: readonly LinkedPullRequest[];
}) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const sections = workspace.tabs.find((tab) => tab.key === "work")?.ui?.sections;
  const showSettled = sections?.["prs:closed"] === true;
  const unlinkPr = useUnlinkPr(props.threadId);
  const [unlink, setUnlink] = useState<LinkedPullRequest | undefined>();
  if (!props.prs.length) return null;
  const current = props.prs.filter((pr) => pr.state === "open" || pr.state === "draft");
  const settled = props.prs.filter((pr) => pr.state === "merged" || pr.state === "closed");
  const row = (pr: LinkedPullRequest) => (
    <PrRow
      key={`${pr.repo.owner}/${pr.repo.name}#${pr.number}`}
      threadId={props.threadId}
      workspaceId={props.workspaceId}
      pr={pr}
      onUnlink={() => setUnlink(pr)}
    />
  );
  return (
    <Section name="Other pull requests">
      {current.length > 0 && <ul className="min-w-0">{current.map(row)}</ul>}
      {settled.length > 0 && (
        <p className="flex h-7 min-w-0 items-center gap-1 px-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{settledWords(settled)}</span>
          <span aria-hidden className="text-subtle-foreground">
            ·
          </span>
          <QuietLink
            expanded={showSettled}
            label={showSettled ? "Hide merged and closed pull requests" : undefined}
            onClick={() =>
              actions.updateUi("work", { sections: { ...sections, "prs:closed": !showSettled } })
            }
          >
            {showSettled ? "Hide" : "Show"}
          </QuietLink>
        </p>
      )}
      {showSettled && settled.length > 0 && (
        <ul aria-label="Merged and closed pull requests" className="min-w-0">
          {settled.map(row)}
        </ul>
      )}
      {unlink && (
        <PrUnlinkDialog
          number={unlink.number}
          onClose={() => setUnlink(undefined)}
          onUnlink={() => unlinkPr({ number: unlink.number, repo: unlink.repo })}
        />
      )}
    </Section>
  );
}
