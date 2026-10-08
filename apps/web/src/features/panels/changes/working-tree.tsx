import type { ThreadDetails } from "@ace/protocol";
import { DiffStat } from "./diff-stat.tsx";

/**
 * The checkout as the daemon last read it: what is uncommitted on the branch right now, which
 * may differ from the agents' edits above once someone commits or edits by hand.
 */
export function WorkingTree(props: { details: ThreadDetails | undefined }) {
  const { details } = props;
  if (!details?.diff || details.branch === undefined) return null;
  const { files, additions, deletions } = details.diff;
  return (
    <p
      role="status"
      aria-label="Working tree"
      className="flex items-center gap-2 border-b px-3.5 py-1.5 text-xs text-muted-foreground"
    >
      <span className="shrink-0">{files ? "Uncommitted:" : "Everything is committed"}</span>
      {files > 0 && (
        <DiffStat
          additions={additions}
          deletions={deletions}
          className="shrink-0 whitespace-nowrap"
        />
      )}
    </p>
  );
}
