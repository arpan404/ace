import { cn } from "@/lib/cn.ts";
import { useThreadDiffStat } from "./use-turns.ts";

/** "+41 −9" in mono: the only diff colour outside the diff itself. */
export function DiffStat(props: { additions: number; deletions: number; className?: string }) {
  if (!props.additions && !props.deletions) return null;
  return (
    <span className={cn("font-mono text-[11px] tabular-nums", props.className)}>
      <span aria-hidden>
        <span className="text-status-done">+{props.additions}</span>{" "}
        <span className="text-status-failed">−{props.deletions}</span>
      </span>
      <span className="sr-only">{` ${props.additions} added, ${props.deletions} removed`}</span>
    </span>
  );
}

/** The Changes tab's badge: the thread's whole diff stat, live. */
export function ThreadDiffStat(props: { threadId: string }) {
  const stat = useThreadDiffStat(props.threadId);
  return <DiffStat {...stat} />;
}
