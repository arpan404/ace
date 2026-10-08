import { DiffStat } from "@/components/diff-stat.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useScopedDiff } from "@/lib/diffs/use-scoped-diff.ts";

export { DiffStat };

/** The Changes tab counts the selected scope, including uncommitted checkout edits. */
export function ThreadDiffStat(props: { threadId: string; folded?: boolean | undefined }) {
  const { stat, label } = useScopedDiff(props.threadId);
  if (!stat.additions && !stat.deletions) return null;
  if (props.folded) return <Dot tone={stat.additions ? "done" : "failed"} />;
  return (
    <Tip label={`${label}: +${stat.additions} −${stat.deletions}`}>
      <span className="inline-flex">
        <span className="mr-1 text-xs text-subtle-foreground">{label}</span>
        <DiffStat {...stat} />
      </span>
    </Tip>
  );
}
