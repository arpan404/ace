import { DiffStat } from "@/components/diff-stat.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useThreadDiffStat } from "@/lib/diffs/use-turns.ts";

export { DiffStat };

/**
 * The Changes tab's badge: the thread's whole diff stat, live, with a tooltip that says it is
 * the whole thread's (the tab itself may be scoped to the last turn). Folded to the tab's icon,
 * a dot keeps the "has changes" signal.
 */
export function ThreadDiffStat(props: { threadId: string; folded?: boolean | undefined }) {
  const stat = useThreadDiffStat(props.threadId);
  if (!stat.additions && !stat.deletions) return null;
  if (props.folded) return <Dot tone={stat.additions ? "done" : "failed"} />;
  return (
    <Tip label={`This thread: +${stat.additions} −${stat.deletions}`}>
      <span className="inline-flex">
        <DiffStat {...stat} />
      </span>
    </Tip>
  );
}
