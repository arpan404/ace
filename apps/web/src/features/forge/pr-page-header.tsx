import type { ReactNode } from "react";
import type { GateKey } from "@ace/ui-core";
import { StateWords } from "@/components/forge-marks.tsx";
import { WorkHeading } from "@/components/work-heading.tsx";
import { useBackLabel } from "@/components/back-label.tsx";
import type { PrActions } from "./pr-actions.ts";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";
import { BehindBase, PrPrimaryControl, PrTitle } from "./pr-header.tsx";
import { PrAgentChip } from "./pr-agent-chip.tsx";
import { PrReviewButton } from "./pr-review-popover.tsx";
import { PrMergeLines } from "./pr-merge-lines.tsx";
import { PrGatesLine } from "./pr-gates-row.tsx";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";

/**
 * A pull request's header on its own page, compact: back with Review and Merge (its method
 * beside it) at the right; the title with its number; the state in words and who wants to
 * merge what where; then, while it is open, one line of facts in words (checks, reviews,
 * conflicts, how fresh the branch is), each jumping to its detail. Opening it on GitHub and
 * copying its checkout command live in the ⋯ menu.
 */
export function PrPageHeader(props: {
  actions: PrActions;
  extensions?: PrWorkspaceExtensions | undefined;
  menu: ReactNode;
  behindOpen: boolean;
  onGate(key: GateKey): void;
  onBehindOpen(open: boolean): void;
  onBack?: (() => void) | undefined;
}) {
  const { actions } = props;
  const { context } = actions;
  const { detail } = context;
  const { status } = detail;
  const backLabel = useBackLabel("Pull requests");
  const commits = `${detail.commits} ${detail.commits === 1 ? "commit" : "commits"}`;
  const deleted = actions.lifecycle.snapshot?.headBranch?.exists === false;
  return (
    <header className="shrink-0 px-[var(--forge-gutter,1rem)] pt-4 pb-3">
      <WorkHeading
        back={props.onBack && { label: backLabel, onBack: props.onBack }}
        title={<PrTitle actions={actions} condensed={false} page />}
        actions={
          <>
            {props.extensions?.headerActions?.(context)}
            <PrAgentChip detail={detail} compact={false} />
            <PrReviewButton />
            {/* A merged or closed PR's state is in words under the title, not a button. */}
            {actions.primary.kind !== "state" && <PrPrimaryControl actions={actions} />}
            {props.menu}
          </>
        }
        badge={status.state === "unknown" ? null : <StateWords state={status.state} />}
        byline={
          <>
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
            <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
            <span className="text-foreground/85">{detail.author}</span>
            <span>
              {status.state === "merged"
                ? `merged ${commits} into`
                : `wants to merge ${commits} into`}
            </span>
            <span className="font-mono text-xs text-foreground/85">{detail.baseBranch}</span>
            <span>from</span>
            <span
              className={
                deleted
                  ? "font-mono text-xs text-subtle-foreground line-through"
                  : "font-mono text-xs text-foreground/85"
              }
            >
              {deleted && <span className="sr-only">deleted branch </span>}
              {detail.headBranch}
            </span>
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
            <PrTime at={detail.updatedAt} prefix="updated " />
          </>
        }
      />
      <PrGatesLine
        actions={actions}
        onSelect={props.onGate}
        after={
          <BehindBase actions={actions} open={props.behindOpen} onOpenChange={props.onBehindOpen} />
        }
      />
      <div className="-mx-[var(--forge-gutter,1rem)]">
        <PrMergeLines actions={actions} />
      </div>
    </header>
  );
}
