import type { FileDiff } from "@ace/ui-core";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { FileDiffBlock, type FileView } from "../changes/file-diff.tsx";
import { freshView } from "../changes/file-view.ts";

/*
 * A turn under review, side by side: the turn's diff of the file in the Changes tool's split
 * view, in place of the editor. Keep, Revert and Comment stay on the inline review, one line
 * away.
 */
export function ReviewSideBySide(props: { diff: FileDiff; where: string; onInline(): void }) {
  const [view, setView] = useState<FileView>(freshView);
  return (
    <div
      role="region"
      aria-label={`Side by side, ${props.diff.path}`}
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      tabIndex={-1}
    >
      <div className="sticky top-0 z-[3] flex h-8 shrink-0 items-center gap-2 border-b border-border bg-background pr-1.5 pl-3.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{props.where}</span>
        <Button size="sm" variant="ghost" onClick={props.onInline}>
          Back to inline
        </Button>
      </div>
      <FileDiffBlock
        file={props.diff}
        view={view}
        onView={setView}
        mode="split"
        wrap={false}
        highlighted={() => false}
        renderAnnotation={() => null}
      />
    </div>
  );
}

export default ReviewSideBySide;
