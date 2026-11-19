import { cn } from "@/lib/cn.ts";

/**
 * "+41 −9" in the text around it, added in the diff's green and removed in its red: the only
 * diff colour outside the diff itself. The diff text tokens read at AA on the page in every
 * theme, light and dark.
 */
export function DiffCounts(props: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn("tabular-nums", props.className)}>
      <span aria-hidden>
        <span className="text-diff-add-text">+{props.additions}</span>{" "}
        <span className="text-diff-del-text">−{props.deletions}</span>
      </span>
      <span className="sr-only">{` ${props.additions} added, ${props.deletions} removed`}</span>
    </span>
  );
}

/** The counts in mono beside code: file headers, file trees, toolbars. Nothing when both are 0. */
export function DiffStat(props: { additions: number; deletions: number; className?: string }) {
  if (!props.additions && !props.deletions) return null;
  return <DiffCounts {...props} className={cn("font-mono text-[11px]", props.className)} />;
}
