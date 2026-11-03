import { Suspense, useMemo } from "react";
import type { ForgeFile, ForgePrDetail, ForgePrStatus } from "@ace/protocol";
import type { TreeFile } from "@ace/ui-core";
import { DeferredFileTree } from "@/features/panels/index.ts";
import { useScopeWorkspace } from "@/lib/workspace/index.ts";
import type { PrViewedMark } from "./pr-viewed-marks.ts";

// The diff renderer loads with this view, not with the app's first paint (`preloadPrFiles`).
const FileTree = DeferredFileTree.Component;

type ReviewThread = ForgePrStatus["reviewThreads"][number];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The files beside the diff, with a filter: on All commits every file the PR lists (pages not
 * read yet included, so any file can be jumped to), each with its Viewed mark and how many open
 * conversations it has; above them how many are viewed and how many conversations are open.
 */
export function PrCodeTree(props: {
  scope: string;
  detail: ForgePrDetail;
  /** The files read so far, in the diff's order. */
  files: readonly ForgeFile[];
  /** All commits: the PR's own list of files joins the ones read. */
  all: boolean;
  current: string | undefined;
  marks: ReadonlyMap<string, PrViewedMark | undefined>;
  threads: ReadonlyMap<string, readonly ReviewThread[]>;
  count: number;
  onJump(path: string): void;
}) {
  const workspace = useScopeWorkspace(props.scope);
  const listed = props.detail.files;
  const files = useMemo(() => {
    const seen = new Set(props.files.map((file) => file.path));
    const rest: TreeFile[] = props.all ? (listed ?? []).filter((file) => !seen.has(file.path)) : [];
    return [...props.files, ...rest];
  }, [props.files, props.all, listed]);
  const viewed = new Set([...props.marks].flatMap(([path, mark]) => (mark?.checked ? [path] : [])));
  const open = new Map<string, number>();
  for (const [path, list] of props.threads) {
    const count = list.filter((thread) => !thread.resolved).length;
    if (count) open.set(path, count);
  }
  const openTotal = [...open.values()].reduce((sum, count) => sum + count, 0);
  const marked = [...props.marks.values()].some((mark) => mark !== undefined);
  const summary = [
    marked
      ? `${viewed.size} of ${plural(props.count, "file")} viewed`
      : plural(props.count, "file"),
    ...(openTotal ? [`${plural(openTotal, "open conversation")}`] : []),
  ].join(" · ");
  return (
    <aside
      aria-label="Files"
      className="flex w-[34%] max-w-72 min-w-48 shrink-0 flex-col border-r border-border"
    >
      <p className="flex h-8 shrink-0 items-center px-3 text-xs text-subtle-foreground tabular-nums">
        {summary}
      </p>
      <Suspense fallback={null}>
        <FileTree
          threadId={props.scope}
          tabKey={workspace.active}
          className="min-h-0 flex-1"
          files={files}
          current={props.current}
          viewed={viewed}
          marks={props.marks}
          comments={open}
          onJump={(index) => {
            const file = files[index];
            if (file) props.onJump(file.path);
          }}
        />
      </Suspense>
    </aside>
  );
}
