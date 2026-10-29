import type { LinkedPullRequest } from "@ace/protocol";
import { formatCount } from "@ace/ui-core";
import { CaretDownIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { capsule } from "../agents/task-capsule.tsx";
import { PrDot } from "../agents/pr-chip.tsx";
import { cn } from "@/lib/cn.ts";
import { pullRequestTab, useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { usePrPrefetch } from "@/lib/forge-pr-detail.ts";
import { useUnlinkPr } from "./pr-unlink.ts";
import { PrUnlinkDialog } from "./pr-unlink-dialog.tsx";

/** Rows shown before the rest fold into "N more". */
const shown = 4;
const foldKey = "prs:all";

function stateLine(pr: LinkedPullRequest): string {
  switch (pr.state) {
    case "open":
      return "in review";
    case "draft":
      return "draft";
    case "merged":
      return "merged";
    case "closed":
      return "closed";
  }
}

/**
 * The pull requests the thread linked or its agents opened, in review first, then merged, each
 * newest first (`summaryPullRequests`). Each row opens the PR in the side panel; its × unlinks
 * it from the thread after asking. Past four, the rest fold into one "N more" row.
 */
export function PullRequests(props: {
  threadId: string;
  workspaceId: string;
  prs: readonly LinkedPullRequest[];
}) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  // Pointing at a row starts reading the PR, so its panel opens on it.
  const prefetch = usePrPrefetch(props.workspaceId);
  const sections = workspace.tabs.find((tab) => tab.key === "work")?.ui?.sections;
  const all = sections?.[foldKey] === true;
  // Never fold away a PR still in review.
  const keep = Math.max(shown, props.prs.filter((pr) => pr.state !== "merged").length);
  // One more row is no fold worth having.
  const folds = props.prs.length > keep + 1;
  const rows = folds && !all ? props.prs.slice(0, keep) : props.prs;
  const rest = props.prs.slice(keep);
  const restWord = rest.every((pr) => pr.state === "merged") ? " merged" : "";
  const unlinkPr = useUnlinkPr(props.threadId);
  const [unlink, setUnlink] = useState<LinkedPullRequest | undefined>();
  return (
    <>
      <ul>
        {rows.map((pr) => (
          <li key={`${pr.repo.owner}/${pr.repo.name}#${pr.number}`} className="group/pr">
            <div className={cn("flex min-w-0 items-center gap-0.5", capsule)}>
              <button
                type="button"
                title={pr.title}
                aria-label={`Pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, ${stateLine(pr)}`}
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
                className="focus-ring-inset flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-ui"
              >
                <span className="grid size-4.5 shrink-0 place-items-center">
                  <PrDot state={pr.state} />
                </span>
                <span className="min-w-0 shrink truncate">{pr.title ?? `#${pr.number}`}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
                  {stateLine(pr)}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  #{pr.number}
                </span>
              </button>
              <IconButton
                icon={XIcon}
                label={`Unlink pull request #${pr.number}`}
                size="sm"
                onClick={() => setUnlink(pr)}
                className="mr-1 hidden group-hover/pr:inline-grid group-focus-within/pr:inline-grid pointer-coarse:inline-grid"
              />
            </div>
          </li>
        ))}
        {folds && (
          <li>
            <button
              type="button"
              aria-expanded={all}
              onClick={() =>
                actions.updateUi("work", { sections: { ...sections, [foldKey]: !all } })
              }
              className={cn(
                "focus-ring-inset flex h-8 w-full items-center gap-2 px-2 text-left text-xs text-muted-foreground hover:text-foreground",
                capsule,
              )}
            >
              <span className="grid size-4.5 shrink-0 place-items-center">
                <CaretDownIcon
                  aria-hidden
                  size={12}
                  className={cn(
                    "text-faint-foreground transition-transform duration-(--motion-base) ease-out",
                    !all && "-rotate-90",
                  )}
                />
              </span>
              {all ? "Show fewer" : `${formatCount(rest.length)} more${restWord}`}
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
      </ul>
    </>
  );
}
