import type { ReactNode } from "react";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrChangesGlance } from "./pr-changes-glance.tsx";
import { PrDescription } from "./pr-description.tsx";
import { PrStackSummary } from "./pr-stack-summary.tsx";
import { TextAction } from "./pr-text-action.tsx";

/**
 * The Summary tab: a main column led by where the merge stands (one sentence, the gates, then
 * what blocks it in its authors' words), then the description, the biggest changes and the stack; and a sidebar (`about`) with the people,
 * labels, the agent and what it's filed under. A narrow view stacks the sidebar under the column.
 * The conversation lives in the Timeline and the checks in Checks: a line here leads to each.
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
  const comments = detail.status.comments.length;
  return (
    <div className="grid gap-6 px-[var(--forge-gutter,1rem)] pt-4 pb-10 @min-[50rem]/pr:grid-cols-[minmax(0,1fr)_15rem] @min-[50rem]/pr:gap-8">
      <div className="min-w-0 space-y-7">
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
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {comments
            ? `${comments} ${comments === 1 ? "comment" : "comments"} in the Timeline`
            : "No comments yet"}
          <span aria-hidden className="text-subtle-foreground">
            ·
          </span>
          <TextAction strong onClick={props.onTimeline}>
            {comments ? "Open the conversation" : "Leave a comment"}
          </TextAction>
        </p>
        {props.extensions?.summary?.(context)}
      </div>
      {props.about && <div className="min-w-0 @min-[50rem]/pr:pt-1">{props.about}</div>}
    </div>
  );
}
