import type { ReactNode } from "react";
import { WorkHeading } from "@/components/work-heading.tsx";
import { useBackLabel } from "@/components/back-label.tsx";
import type { PrActions } from "./pr-actions.ts";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrByline, PrPrimaryControl, PrTitle } from "./pr-header.tsx";
import { PrAgentChip } from "./pr-agent-chip.tsx";
import { PrReviewButton } from "./pr-review-popover.tsx";
import { useBlockingItems } from "./pr-attention.tsx";

/**
 * A pull request's header on its own page, as GitHub sets it: back with Review and Merge (its
 * method beside it) at the right; the title in large type with its number; then the state's
 * pill and who wants to merge what where. What stands in the way of the merge is the Summary's
 * merge box. Opening it on GitHub lives in the ⋯ menu.
 */
export function PrPageHeader(props: {
  actions: PrActions;
  extensions?: PrWorkspaceExtensions | undefined;
  menu: ReactNode;
  onBack?: (() => void) | undefined;
  /** Takes the person to what blocks the merge. */
  onBlocked(): void;
}) {
  const { actions } = props;
  const { context } = actions;
  const { detail } = context;
  const backLabel = useBackLabel("Pull requests");
  const blocking = useBlockingItems(detail);
  return (
    <header className="shrink-0 px-[var(--forge-gutter,1rem)] pt-4 pb-4">
      <WorkHeading
        back={props.onBack && { label: backLabel, onBack: props.onBack }}
        title={<PrTitle actions={actions} condensed={false} page />}
        actions={
          <>
            {props.extensions?.headerActions?.(context)}
            <PrAgentChip detail={detail} compact={false} />
            <PrReviewButton />
            {/* A merged or closed PR's state is its pill under the title, not a button. */}
            {actions.primary.kind !== "state" && (
              <PrPrimaryControl
                actions={actions}
                onBlocked={props.onBlocked}
                blockingCount={blocking.length}
              />
            )}
            {props.menu}
          </>
        }
      />
      <div className="mt-2">
        <PrByline actions={actions} />
      </div>
    </header>
  );
}
