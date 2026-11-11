import type { ReactNode } from "react";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrChangesGlance } from "./pr-changes-glance.tsx";
import { PrDescription } from "./pr-description.tsx";
import { PrStackSummary } from "./pr-stack-summary.tsx";
import { PrLatest } from "./pr-latest.tsx";

/**
 * The Summary tab: a main column of sections (Merge status, Description, Files changed, the
 * stack, Latest) and a sidebar (`about`) with the agent, the people, labels and what it's filed
 * under. A narrow view stacks the sidebar under the column.
 */
export function PrSummary(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  stack?: { number: number; size: number; position: number } | undefined;
  onOpen(number: number): void;
  onOpenCode(path?: string, line?: number): void;
  onTimeline(): void;
  /** Opens the details editor, when GitHub lets this account edit them. */
  onEdit: (() => void) | undefined;
  /** Reviewers, assignees, labels, the agent, the milestone and linked issues. */
  about?: ReactNode;
  /** The merge box (`PrMergeBox`), with what blocks the merge at its top. */
  merge: ReactNode;
  /** Saves the description with one task box ticked, when the viewer may edit it. */
  onTasks?: ((body: string) => Promise<boolean>) | undefined;
}) {
  const { context } = props;
  const { detail } = context;
  return (
    <div className="grid gap-8 px-[var(--forge-gutter,1rem)] pt-6 pb-12 @min-[50rem]/pr:grid-cols-[minmax(0,1fr)_14.5rem] @min-[50rem]/pr:gap-10">
      <div className="min-w-0 space-y-8">
        {props.merge}
        <PrDescription
          context={context}
          extensions={props.extensions}
          onOpen={props.onOpen}
          onEdit={props.onEdit}
          onTasks={props.onTasks}
        />
        <PrChangesGlance
          workspaceId={context.workspaceId}
          detail={detail}
          onOpenCode={props.onOpenCode}
        />
        {props.stack && (
          <PrStackSummary
            workspaceId={context.workspaceId}
            detail={detail}
            stack={props.stack}
            onRefresh={() => void context.refresh()}
            onOpen={props.onOpen}
          />
        )}
        <PrLatest detail={detail} onTimeline={props.onTimeline} />
        {props.extensions?.summary?.(context)}
      </div>
      {props.about && <div className="min-w-0 @min-[50rem]/pr:pt-0.5">{props.about}</div>}
    </div>
  );
}
