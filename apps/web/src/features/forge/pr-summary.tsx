import type { ReactNode } from "react";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrChangesGlance } from "./pr-changes-glance.tsx";
import { PrDescription } from "./pr-description.tsx";
import { PrStackSummary } from "./pr-stack-summary.tsx";

/**
 * The Summary tab, laid out as GitHub lays out a pull request: a main column of boxes (the
 * description, the merge box, the files changed, the stack) and a sidebar (`about`) with the
 * people, labels, the agent and what it's filed under. A narrow view stacks the sidebar under
 * the column.
 */
export function PrSummary(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  stack?: { number: number; size: number; position: number } | undefined;
  onOpen(number: number): void;
  onOpenCode(path?: string, line?: number): void;
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
    <div className="grid gap-6 px-[var(--forge-gutter,1rem)] pt-5 pb-12 @min-[50rem]/pr:grid-cols-[minmax(0,1fr)_15.5rem] @min-[50rem]/pr:gap-8">
      <div className="min-w-0 space-y-5">
        <PrDescription
          context={context}
          extensions={props.extensions}
          onOpen={props.onOpen}
          onEdit={props.onEdit}
          onTasks={props.onTasks}
        />
        {props.merge}
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
        {props.extensions?.summary?.(context)}
      </div>
      {props.about && <div className="min-w-0 @min-[50rem]/pr:pt-0.5">{props.about}</div>}
    </div>
  );
}
