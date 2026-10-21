import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrAttention } from "./pr-attention.tsx";
import { PrPeople } from "./pr-people.tsx";
import { PrChangesGlance } from "./pr-changes-glance.tsx";
import { PrDescription } from "./pr-description.tsx";
import { PrStackSummary } from "./pr-stack-summary.tsx";
import { PrChecks } from "./pr-checks.tsx";
import { PrComments } from "./pr-comments.tsx";
import { composerClearance } from "./pr-composer.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The Summary tab, top to bottom: what needs attention, reviewers and labels, the biggest
 * changes, the description, the stack, the checks (folded) and the conversation. Every write
 * lives in the header and its ⋯ menu.
 */
export function PrSummary(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  hostThreadId?: string | undefined;
  stack?: { number: number; size: number; position: number } | undefined;
  refreshing: boolean;
  /** Bumped by the Checks gate: the checks open and scroll into view. */
  revealChecks?: number | undefined;
  onRefresh(): void;
  onOpen(number: number): void;
  onOpenCode(path?: string): void;
  /** Opens the reviewer request, when this PR can take one. */
  onRequestReview: (() => void) | undefined;
  /** Opens the details editor, when GitHub lets this account edit them. */
  onEdit: (() => void) | undefined;
}) {
  const { context } = props;
  const { detail } = context;
  return (
    <div className={cn("space-y-3 px-[var(--forge-gutter,1rem)] pt-2", composerClearance)}>
      <PrAttention
        workspaceId={context.workspaceId}
        detail={detail}
        hostThreadId={props.hostThreadId}
        disabled={context.disabled}
      />
      <PrPeople
        context={context}
        extensions={props.extensions}
        onRequestReview={props.onRequestReview}
        onEdit={props.onEdit}
      />
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
      <PrChecks
        context={context}
        refreshing={props.refreshing}
        reveal={props.revealChecks}
        hostThreadId={props.hostThreadId}
        onRefresh={props.onRefresh}
        onOpen={props.onOpen}
        onOpenCode={props.onOpenCode}
      />
      <PrComments status={detail.status} />
      {props.extensions?.summary?.(context)}
    </div>
  );
}
