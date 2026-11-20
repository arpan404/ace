import type { FileChanges } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import type { DeckCompareProps, TextBuffer } from "@/features/editor-workbench/index.ts";
import { useFileChanges } from "@/lib/diffs/use-file-diffs.ts";
import { FileDiffBlock, type FileView } from "../changes/file-diff.tsx";
import { freshView } from "../changes/file-view.ts";

/*
 * Compare (spec 46): the disk's text on the left and the unsaved buffer on the right, in the
 * Changes tool's split diff, computed by its diff worker. The answers (Merge, Keep mine, Take
 * theirs) sit on the notice line above, so the diff is all this draws.
 */

interface Sides {
  theirs: string;
  mine: string;
}

/** The disk's text and the buffer's, while the change waits for an answer. */
function sidesOf(buffer: TextBuffer): Sides | undefined {
  const clash = buffer.snapshot().clash;
  const mine = buffer.document()?.text();
  if (mine === undefined || (clash?.kind !== "changed" && clash?.kind !== "merging")) return;
  return { theirs: clash.theirs.text, mine };
}

/** The two texts, read again whenever the buffer or its clash changes. */
function useSides(buffer: TextBuffer): Sides | undefined {
  const [sides, setSides] = useState(() => sidesOf(buffer));
  useEffect(() => {
    const update = () =>
      setSides((was) => {
        const next = sidesOf(buffer);
        return was && next && was.theirs === next.theirs && was.mine === next.mine ? was : next;
      });
    update();
    return buffer.subscribe(update);
  }, [buffer]);
  return sides;
}

export function DeckCompare(props: DeckCompareProps) {
  const { path } = props;
  const sides = useSides(props.buffer);
  const files = useMemo<FileChanges[]>(
    () =>
      sides
        ? [
            {
              path,
              changes: [{ path, kind: "update", oldText: sides.theirs, newText: sides.mine }],
            },
          ]
        : [],
    [path, sides],
  );
  const diff = useFileChanges(files).files[0];
  const [view, setView] = useState<FileView>(freshView);
  return (
    <div
      role="region"
      aria-label={`Compare ${path}`}
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      tabIndex={-1}
    >
      <div className="sticky top-0 z-[3] grid h-7 shrink-0 grid-cols-2 border-b border-border bg-background text-xs font-medium text-muted-foreground">
        <span className="flex items-center px-3.5">On disk</span>
        <span className="flex items-center border-l border-border px-3.5">Your changes</span>
      </div>
      {diff ? (
        <FileDiffBlock
          file={diff}
          view={view}
          onView={setView}
          mode="split"
          wrap={false}
          highlighted={() => false}
          renderAnnotation={() => null}
        />
      ) : (
        <div className="flex-1" aria-busy="true" aria-label="Comparing" />
      )}
    </div>
  );
}
