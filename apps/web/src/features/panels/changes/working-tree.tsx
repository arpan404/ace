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
  const branch = details.branch ?? "detached HEAD";
  const ahead = details.ahead ? ` · ${details.ahead} to push` : "";
  return (
    <p
      role="status"
      aria-label="Working tree"
      className="flex items-center gap-2 border-b px-3.5 py-1.5 text-xs text-subtle-foreground"
    >
      <span className="min-w-0 truncate">
        {files
          ? `${files} ${files === 1 ? "file" : "files"} uncommitted on `
          : "Everything is committed on "}
        <span className="font-mono">{branch}</span>
        {ahead}
      </span>
      {files > 0 && <DiffStat additions={additions} deletions={deletions} />}
    </p>
  );
}
