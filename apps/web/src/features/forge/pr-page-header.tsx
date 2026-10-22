import type { ReactNode } from "react";
import { StateBadge } from "@/components/forge-marks.tsx";
import { WorkHeading } from "@/components/work-heading.tsx";
import { useBackLabel } from "@/components/back-label.tsx";
import type { PrActions } from "./pr-actions.ts";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";
import { BehindBase, PrPrimaryControl, PrTitle } from "./pr-header.tsx";
import { PrAgentChip } from "./pr-agent-chip.tsx";
import { PrReviewButton } from "./pr-review-popover.tsx";
import { PrMergeLines } from "./pr-merge-lines.tsx";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";

/**
 * A pull request's header on its own page, laid out as an issue's page is (`WorkHeading`): back
 * and the actions, the title in large type with its number, the state badge and who wants to
 * merge what where, then (while it is open) one line saying what stands between it and a merge.
 * Opening it on GitHub and copying its checkout command live in the ⋯ menu.
 */
export function PrPageHeader(props: {
  actions: PrActions;
  extensions?: PrWorkspaceExtensions | undefined;
  menu: ReactNode;
  behindOpen: boolean;
  gates: ReactNode;
  onBehindOpen(open: boolean): void;
  onBack?: (() => void) | undefined;
}) {
  const { actions } = props;
  const { context } = actions;
  const { detail } = context;
  const { status } = detail;
  const backLabel = useBackLabel("Pull requests");
  const commits = `${detail.commits} ${detail.commits === 1 ? "commit" : "commits"}`;
  return (
    <header className="shrink-0 px-[var(--forge-gutter,1rem)] pt-6 pb-4">
      <WorkHeading
        back={props.onBack && { label: backLabel, onBack: props.onBack }}
        title={<PrTitle actions={actions} condensed={false} page />}
        actions={
          <>
            {props.extensions?.headerActions?.(context)}
            <PrAgentChip detail={detail} compact={false} />
            <PrReviewButton />
            {/* A merged or closed PR's state is the badge under the title, not a button. */}
            {actions.primary.kind !== "state" && <PrPrimaryControl actions={actions} />}
            {props.menu}
          </>
        }
        badge={status.state === "unknown" ? null : <StateBadge kind="pr" state={status.state} />}
        byline={
          <>
            <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
            <span className="font-medium text-foreground/85">{detail.author}</span>
            <span>
              {status.state === "merged"
                ? `merged ${commits} into`
                : `wants to merge ${commits} into`}
            </span>
            <span className="font-mono text-xs text-foreground/85">{detail.baseBranch}</span>
            <span>from</span>
            {actions.lifecycle.snapshot?.headBranch?.exists === false ? (
              <span className="font-mono text-xs text-subtle-foreground line-through">
                <span className="sr-only">deleted branch </span>
                {detail.headBranch}
              </span>
            ) : (
              <span className="font-mono text-xs text-foreground/85">{detail.headBranch}</span>
            )}
            <BehindBase
              actions={actions}
              open={props.behindOpen}
              onOpenChange={props.onBehindOpen}
            />
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
            <PrTime at={detail.updatedAt} prefix="updated " />
          </>
        }
      />
      {props.gates}
      <div className="-mx-[var(--forge-gutter,1rem)]">
        <PrMergeLines actions={actions} />
      </div>
    </header>
  );
}
