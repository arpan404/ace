import { FileIcon } from "@ace/icons";
import { gitPatchFiles, type FileChanges } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import type { EditorCompareProps, TextBuffer } from "@/features/editor-workbench/index.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useFileChanges } from "@/lib/diffs/use-file-diffs.ts";
import { FileDiffBlock, type FileView } from "../changes/file-diff.tsx";
import { freshView } from "../changes/file-view.ts";
import { sceneBar } from "@/components/ui/rules.ts";
import { readFileGitDiff } from "./source-control/source-control-source.ts";
import { sourceControlDiffKey } from "./source-control/use-source-control.ts";

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

export function EditorCompare(props: EditorCompareProps) {
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
      <div
        className={`sticky top-0 z-[3] grid h-7 shrink-0 grid-cols-2 border-b border-border bg-background text-xs font-medium text-muted-foreground ${sceneBar}`}
      >
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

/**
 * Source control's staged or unstaged diff for one file, rendered with the same Changes
 * `FileDiffBlock` component inside the editor pane.
 */
export function GitDiffCompare(props: {
  threadId: string;
  path: string;
  stage: "staged" | "unstaged";
  oldPath?: string | undefined;
  onOpenFile(): void;
}) {
  const { threadId, path, stage, oldPath } = props;
  const query = useDaemonQuery({
    queryKey: [...sourceControlDiffKey(threadId), path, stage, oldPath],
    staleTime: 0,
    retry: false,
    read: (client, signal) =>
      readFileGitDiff(client, threadId, { path, stage, from: oldPath }, signal),
  });
  const file = useMemo(() => {
    const patch = query.data?.patch;
    if (!patch) return undefined;
    return gitPatchFiles(patch)[0];
  }, [query.data?.patch]);
  const [view, setView] = useState<FileView>(freshView);
  const leftTitle = stage === "staged" ? "HEAD" : "Index";
  const rightTitle = stage === "staged" ? "Staged" : "Working tree";

  return (
    <div
      role="region"
      aria-label={`Changes in ${path}`}
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      tabIndex={-1}
    >
      <div
        className={`sticky top-0 z-[3] grid h-7 shrink-0 grid-cols-2 border-b border-border bg-background text-xs font-medium text-muted-foreground ${sceneBar}`}
      >
        <span className="flex items-center px-3.5">{leftTitle}</span>
        <span className="flex items-center justify-between border-l border-border pr-1.5 pl-3.5">
          <span>{rightTitle}</span>
          <IconButton
            icon={FileIcon}
            label="Open file"
            size="sm"
            onClick={props.onOpenFile}
            className="size-5 rounded-sm hover:bg-hover"
          />
        </span>
      </div>
      {query.isPending && !query.data ? (
        <div className="flex-1 p-3.5 text-xs text-muted-foreground" aria-busy="true">
          Reading changes…
        </div>
      ) : query.isError ? (
        <div role="alert" className="flex-1 p-3.5 text-xs text-muted-foreground">
          Couldn&apos;t read changes for {path}.
        </div>
      ) : file ? (
        <FileDiffBlock
          file={file}
          view={view}
          onView={setView}
          mode="split"
          wrap={false}
          highlighted={() => false}
          renderAnnotation={() => null}
        />
      ) : (
        <div className="flex-1 p-3.5 text-xs text-muted-foreground">
          No {stage} changes in {path}.
        </div>
      )}
    </div>
  );
}
