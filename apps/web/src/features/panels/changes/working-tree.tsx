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
      className="flex items-center gap-2 border-b px-3.5 py-1.5 text-xs text-muted-foreground"
    >
      <span className="min-w-0 truncate">
        {/* Named, so it never reads as a third count of the same edits beside the tab's
            (the whole thread) and the scope's (a turn). */}
        <span className="font-medium text-foreground">Working tree: </span>
        {files
          ? `${files} ${files === 1 ? "file" : "files"} uncommitted on `
          : "Everything is committed on "}
        <span className="font-mono">{branch}</span>
        {ahead}
      </span>
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
