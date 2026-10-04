import { DiffStat } from "@/components/diff-stat.tsx";
import { useThreadDiffStat } from "@/lib/diffs/use-turns.ts";

export { DiffStat };

/** The Changes tab's badge: the thread's whole diff stat, live. */
export function ThreadDiffStat(props: { threadId: string }) {
  const stat = useThreadDiffStat(props.threadId);
  return <DiffStat {...stat} />;
}
