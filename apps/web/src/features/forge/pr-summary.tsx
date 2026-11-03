import type { ReactNode } from "react";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrAttention } from "./pr-attention.tsx";
import { PrChangesGlance } from "./pr-changes-glance.tsx";
import { PrDescription } from "./pr-description.tsx";
import { PrStackSummary } from "./pr-stack-summary.tsx";
import { TextAction } from "./pr-text-action.tsx";

/**
 * The Summary tab, top to bottom: what blocks the merge, in its authors' words; About (people,
 * labels, the agent, what it's filed under); the biggest changes; the description; the stack.
 * The conversation lives in the Timeline and the checks in Checks: a line here leads to each.
 */
export function PrSummary(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  hostThreadId?: string | undefined;
  stack?: { number: number; size: number; position: number } | undefined;
  onOpen(number: number): void;
  onOpenCode(path?: string, line?: number): void;
  onOpenCheck(id: string): void;
  onTimeline(): void;
  /** Opens the details editor, when GitHub lets this account edit them. */
  onEdit: (() => void) | undefined;
  /** Reviewers, assignees, labels, the agent, the milestone and linked issues. */
  about?: ReactNode;
  /** Saves the description with one task box ticked, when the viewer may edit it. */
  onTasks?: ((body: string) => Promise<boolean>) | undefined;
}) {
  const { context } = props;
  const { detail } = context;
  const comments = detail.status.comments.length;
  return (
    <div className="space-y-5 px-[var(--forge-gutter,1rem)] pt-3 pb-10">
      <PrAttention
        workspaceId={context.workspaceId}
        detail={detail}
        hostThreadId={props.hostThreadId}
        disabled={context.disabled}
        onRefresh={context.refresh}
        onOpenCode={(path, line) => props.onOpenCode(path, line)}
        onOpenCheck={props.onOpenCheck}
      />
      {props.about}
      <PrChangesGlance
        workspaceId={context.workspaceId}
        detail={detail}
        onOpenCode={props.onOpenCode}
      />
      <PrDescription
        context={context}
        extensions={props.extensions}
        onOpen={props.onOpen}
        onEdit={props.onEdit}
        onTasks={props.onTasks}
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
  );
}
