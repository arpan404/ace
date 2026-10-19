import type { FileDiff } from "@ace/ui-core";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { VirtualRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import type { DiffLayout } from "./diff-layout.ts";
import { fileHeight } from "./file-diff.tsx";
import { FileTree } from "./file-tree.tsx";
import { freshView, type FileView } from "./file-view.ts";

/** Past this many rows across the files shown, only the files near the viewport mount. */
const virtualRowsAbove = 2_000;
/** A file viewed at its current version starts folded; one object, so its block stays memoized. */
const foldedView: FileView = { ...freshView, open: false };
const noVersions: ReadonlyMap<string, string> = new Map();

/**
 * How each file shows (open, folds expanded), kept by path and version so a file scrolled out
 * of a long list and back keeps it, and a new version of the file starts fresh. Files in
 * `folded` start collapsed; anything opened by hand stays as left.
 */
export function useFileViews(
  files: readonly FileDiff[],
  versions: ReadonlyMap<string, string> = noVersions,
  folded?: ReadonlySet<string>,
) {
  const [views, setViews] = useState<ReadonlyMap<string, { version: string; view: FileView }>>(
    () => new Map(),
  );
  const versionOf = (path: string) => versions.get(path) ?? "";
  const viewOf = (file: FileDiff): FileView => {
    const kept = views.get(file.path);
    if (kept && kept.version === versionOf(file.path)) return kept.view;
    return folded?.has(file.path) ? foldedView : freshView;
  };
  const setView = (path: string, next: FileView) =>
    setViews((previous) => new Map(previous).set(path, { version: versionOf(path), view: next }));
  const allCollapsed = files.length > 0 && files.every((file) => !viewOf(file).open);
  const collapseAll = (fold: boolean) =>
    setViews(
      new Map(
        files.map((file) => [
          file.path,
          { version: versionOf(file.path), view: { ...viewOf(file), open: !fold } },
        ]),
      ),
    );
  return { viewOf, setView, allCollapsed, collapseAll };
}

export interface DiffJump {
  /** Prefix of each file block's element id: `${anchor}-${index}`. */
  anchor: string;
  blocks: RefObject<VirtualRowsHandle | null>;
  /** The file last jumped to. */
  current: string | undefined;
  /** Bring a file into view, opening it if it was folded. */
  jump(path: string): void;
}

/** Jumping to a file's diff, from the tree or a comment; once to `path` when it first appears. */
export function useDiffJump(
  files: readonly FileDiff[],
  views: ReturnType<typeof useFileViews>,
  path: string | undefined,
): DiffJump {
  const anchor = useId();
  const blocks = useRef<VirtualRowsHandle>(null);
  const [current, setCurrent] = useState<string>();
  const jump = (target: string) => {
    const index = files.findIndex((file) => file.path === target);
    if (index < 0) return;
    setCurrent(target);
    const file = files[index];
    if (file && !views.viewOf(file).open)
      views.setView(target, { ...views.viewOf(file), open: true });
    const block = document.getElementById(`${anchor}-${index}`);
    if (block) block.scrollIntoView?.({ block: "start" });
    else blocks.current?.scrollToIndex(index);
  };
  // Opened on a file (a changed-files card): show that file, once its diff is ready.
  const ready = files.some((file) => file.path === path);
  const jumped = useRef<string>(undefined);
  useEffect(() => {
    if (!path || !ready || jumped.current === path) return;
    jumped.current = path;
    const index = files.findIndex((file) => file.path === path);
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- following the tab's request.
    setCurrent(path);
    document.getElementById(`${anchor}-${index}`)?.scrollIntoView?.({ block: "start" });
  }, [path, ready, files, anchor]);
  return { anchor, blocks, current, jump };
}

/**
 * The files of a diff, one block each, beside (or above) the files tree. Long lists mount only
 * the files near the viewport; each block mounts only its rows near it.
 */
export function DiffFiles(props: {
  threadId: string;
  tabKey?: string | undefined;
  files: readonly FileDiff[];
  layout: DiffLayout;
  jump: DiffJump;
  viewOf(file: FileDiff): FileView;
  viewed?: ReadonlySet<string> | undefined;
  comments?: ReadonlyMap<string, number> | undefined;
  /** A line above the files: what is still being prepared, or what was left out. */
  notice?: ReactNode;
  renderFile(file: FileDiff, index: number): ReactNode;
}) {
  const { files, layout, jump } = props;
  const rows = files.reduce((sum, file) => sum + file.rows.length, 0);
  const tree = layout.showTree && (
    <FileTree
      threadId={props.threadId}
      tabKey={props.tabKey}
      files={files}
      current={jump.current}
      viewed={props.viewed ?? none}
      comments={props.comments ?? noComments}
      onJump={(index) => {
        const file = files[index];
        if (file) jump.jump(file.path);
      }}
      className={
        layout.beside ? "w-[240px] shrink-0 border-l" : "max-h-[40%] shrink-0 border-b pb-1"
      }
    />
  );
  return (
    <div className={cn("flex min-h-0 flex-1", layout.beside ? "flex-row" : "flex-col")}>
      {!layout.beside && tree}
      <div data-diff-scroller="" className="min-h-0 min-w-0 flex-1 overflow-auto pb-8">
        {props.notice}
        {files.length > 1 && rows > virtualRowsAbove ? (
          <VirtualRows
            items={files}
            rowKey={(file) => file.path}
            estimate={(file) => fileHeight(file, props.viewOf(file))}
            render={props.renderFile}
            // A file is tall (up to hundreds of rows): two past each edge keep scrolling seamless.
            overscan={2}
            handle={jump.blocks}
          />
        ) : (
          files.map((file, index) => props.renderFile(file, index))
        )}
      </div>
      {layout.beside && tree}
    </div>
  );
}

const none: ReadonlySet<string> = new Set();
const noComments: ReadonlyMap<string, number> = new Map();
