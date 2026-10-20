import type { LinkedPullRequest } from "@ace/protocol";
import { pullRequestTone } from "@/components/pull-request-state.tsx";
import { cn } from "@/lib/cn.ts";

const stateWords: Record<LinkedPullRequest["state"], string> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

/** A pull request's state as a 6px dot in its colour: open green, merged violet, closed red. */
export function PrDot(props: { state: LinkedPullRequest["state"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full bg-current", pullRequestTone(props.state))}
    />
  );
}

/** "#1105" in mono on a quiet chip, its state dot before it. */
export function PrChip(props: { pr: LinkedPullRequest; className?: string | undefined }) {
  return (
    <span
      role="img"
      aria-label={`Pull request #${props.pr.number}, ${stateWords[props.pr.state]}`}
      title={props.pr.title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs bg-fill px-1.5 font-mono text-2xs text-muted-foreground tabular-nums",
        props.className,
      )}
    >
      <PrDot state={props.pr.state} />#{props.pr.number}
    </span>
  );
}
