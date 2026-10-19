import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ForgeFile, ForgePrDetail, ForgeRepository } from "@ace/protocol";
import { useFileChanges } from "@/lib/diffs/use-file-diffs.ts";
import { useScopeWorkspace } from "@/lib/workspace/index.ts";
import { VirtualRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  DeferredFileDiffBlock,
  DeferredFileTree,
  fileHeight,
  freshView,
  useFileViews,
} from "@/features/panels/index.ts";
import { usePrCommits } from "./pr-commits.tsx";
import { codeCaveats, hostedFileChanges, offDiffThreads } from "./pr-code-model.ts";
import { PrCodeFile } from "./pr-code-file.tsx";
import { PrCodeToolbar, type CodeOptions } from "./pr-code-toolbar.tsx";
import type { PrDiffContext, PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { usePrFilePages } from "./pr-file-pages.ts";
import { PrMoreFiles } from "./pr-more-files.tsx";
import { PrOffDiffThreads } from "./pr-off-diff-threads.tsx";
import { usePrViewedMarks } from "./pr-viewed-marks.ts";

// The diff renderer loads with this view, not with the app's first paint (`preloadPrFiles`).
const FileTree = DeferredFileTree.Component;

/** Warm the diff renderer while a pull request is open, before its Code tab is chosen. */
export function preloadPrFiles(): void {
  void DeferredFileDiffBlock.preload().catch(() => {});
  void DeferredFileTree.preload().catch(() => {});
}

/** Past this many diff rows across the files read, only the files near the viewport mount. */
const virtualRowsAbove = 2_000;

interface PrFilesProps {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  /** A file to scroll to (the Summary's Changes); a new `seq` asks again. */
  focus?: { path: string; seq: number } | undefined;
}

/**
 * The Code tab: every changed file of the pull request (or of one commit) in one continuous
 * scroll, read page by page as it nears the end, with the files tree beside it on request.
 */
export function PrFiles(props: PrFilesProps) {
  return <PrFileRange key={`${props.detail.status.headSha}/${props.detail.baseSha}`} {...props} />;
}

function PrFileRange(props: PrFilesProps) {
  const [commit, setCommit] = useState("");
  const [options, setOptions] = useState<CodeOptions>({
    mode: "unified",
    wrap: false,
    tree: false,
  });
  const commits = usePrCommits(props);
  return (
    <PrCodeRange
      key={commit}
      {...props}
      commit={commit}
      onCommit={setCommit}
      commits={commits}
      options={options}
      onOptions={(change) => setOptions((previous) => ({ ...previous, ...change }))}
    />
  );
}

function PrCodeRange(
  props: PrFilesProps & {
    commit: string;
    onCommit(commit: string): void;
    commits: ReturnType<typeof usePrCommits>;
    options: CodeOptions;
    onOptions(change: Partial<CodeOptions>): void;
  },
) {
  const scope = `forge:${props.workspaceId}`;
  const workspace = useScopeWorkspace(scope);
  const pages = usePrFilePages(props);
  const range = pages.range;
  const files = range?.files ?? noFiles;
  const inputs = useMemo(() => hostedFileChanges(files), [files]);
  const diffs = useFileChanges(inputs);
  const byPath = useMemo(() => new Map(diffs.files.map((diff) => [diff.path, diff])), [diffs]);
  const context: PrDiffContext | undefined = range && { ...props.context, files: range };
  const marks = usePrViewedMarks(context, props.extensions);
  const markByPath = new Map(files.map((file) => [file.path, marks.markOf(file)]));
  // A file marked viewed folds; unmarking it, or a new version of its diff, opens it again.
  const versions = new Map(
    files.map((file) => [
      file.path,
      `${diffs.versions.get(file.path) ?? ""}:${markByPath.get(file.path)?.checked ? "viewed" : ""}`,
    ]),
  );
  const folded = new Set(files.filter((file) => markByPath.get(file.path)?.checked).map(pathOf));
  const views = useFileViews(diffs.files, versions, folded);
  const scroller = useRef<HTMLDivElement>(null);
  const blocks = useRef<VirtualRowsHandle>(null);
  const [current, setCurrent] = useState<string>();
  const anchor = `pr-file-${props.commit || "all"}`;
  const jump = (path: string) => {
    const index = files.findIndex((file) => file.path === path);
    if (index < 0) return;
    setCurrent(path);
    const diff = byPath.get(path);
    if (diff && !views.viewOf(diff).open)
      views.setView(path, { ...views.viewOf(diff), open: true });
    const block = document.getElementById(`${anchor}-${index}`);
    if (block) block.scrollIntoView?.({ block: "start" });
    else blocks.current?.scrollToIndex(index);
  };
  // A file picked elsewhere (the Summary's Changes) opens here once its page has loaded.
  const focused = useRef(0);
  const focus = props.focus;
  const ready = files.some((file) => file.path === focus?.path);
  useEffect(() => {
    if (!focus || !ready || focused.current === focus.seq) return;
    focused.current = focus.seq;
    jump(focus.path);
  });
  const complete = pages.more === "done";
  const caveats = codeCaveats({
    viewed: marks.availability,
    withheld: files.some((file) => file.patch === null || file.truncated),
    truncated: range?.truncated ?? false,
    commitsTruncated: props.commits.data?.truncated ?? false,
  });
  if (props.commits.error) caveats.push("Couldn't read the commit list.");
  const threads = props.commit
    ? []
    : offDiffThreads(props.detail.status.reviewThreads, { files, diffs: diffs.files, complete });
  // A single commit's total is known only once its pages are read; the PR's comes with it.
  const fileCount = props.commit ? files.length : props.detail.changedFiles;
  const rows = diffs.files.reduce((sum, diff) => sum + diff.rows.length, 0);
  const renderFile = (file: ForgeFile, index: number) => {
    const diff = byPath.get(file.path);
    return (
      context && (
        <PrCodeFile
          key={file.path}
          id={`${anchor}-${index}`}
          file={file}
          diff={diff}
          context={context}
          extensions={props.extensions}
          view={diff ? views.viewOf(diff) : freshView}
          onView={(next) => views.setView(file.path, next)}
          mode={props.options.mode}
          wrap={props.options.wrap}
          mark={markByPath.get(file.path)}
        />
      )
    );
  };
  return (
    <section
      aria-label="Hosted PR diff"
      className="@container/code flex h-full min-h-0 min-w-0 flex-col"
    >
      <PrCodeToolbar
        commit={props.commit}
        commits={props.commits.data?.commits ?? []}
        onCommit={props.onCommit}
        files={fileCount}
        viewed={marks.count}
        caveats={caveats}
        options={props.options}
        onOptions={props.onOptions}
        allCollapsed={views.allCollapsed}
        onCollapseAll={views.collapseAll}
      />
      {pages.error && (
        <div role="alert" className="space-y-2 px-3.5 py-6 text-center text-xs">
          <p className="font-medium text-foreground">Couldn't load the changed files.</p>
          <p className="text-muted-foreground">{pages.error.message}</p>
          <Button size="xs" onClick={pages.retry}>
            Retry
          </Button>
        </div>
      )}
      {pages.pending && <Spinner label="Reading GitHub" className="m-3.5" />}
      {range && context && (
        <>
          <PrOffDiffThreads threads={threads} onFile={jump} />
          <div className="flex min-h-0 flex-1">
            <div
              ref={scroller}
              data-diff-scroller=""
              className="min-h-0 min-w-0 flex-1 overflow-auto pb-8"
            >
              <p className="sr-only">
                {props.commit
                  ? "Commit compared with its first parent"
                  : "PR compared with its merge base"}
                : {range.baseSha} ← {range.headSha}
              </p>
              <Suspense fallback={null}>
                {files.length > 1 && rows > virtualRowsAbove ? (
                  <VirtualRows
                    items={files}
                    rowKey={pathOf}
                    estimate={(file) => {
                      const diff = byPath.get(file.path);
                      return diff ? fileHeight(diff, views.viewOf(diff)) : 32;
                    }}
                    render={renderFile}
                    // A file is tall (up to hundreds of rows): two past each edge keep scrolling seamless.
                    overscan={2}
                    handle={blocks}
                  />
                ) : (
                  files.map(renderFile)
                )}
              </Suspense>
              {!files.length && complete && (
                <p className="px-3.5 py-6 text-center text-xs text-muted-foreground">
                  No changed files.
                </p>
              )}
              <PrMoreFiles
                state={pages.more}
                loaded={pages.loaded}
                root={scroller}
                onMore={pages.loadMore}
                onRetry={pages.retry}
              />
            </div>
            {props.options.tree && (
              <aside
                aria-label="Files"
                className="flex w-[40%] max-w-80 min-w-48 shrink-0 flex-col border-l border-border"
              >
                <p className="flex h-8 shrink-0 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground">
                  Files
                  <span className="text-subtle-foreground tabular-nums">{fileCount}</span>
                </p>
                <Suspense fallback={null}>
                  <FileTree
                    threadId={scope}
                    tabKey={workspace.active}
                    className="min-h-0 flex-1"
                    files={files}
                    current={current}
                    viewed={folded}
                    comments={noComments}
                    onJump={(index) => {
                      const file = files[index];
                      if (file) jump(file.path);
                    }}
                  />
                </Suspense>
              </aside>
            )}
          </div>
        </>
      )}
    </section>
  );
}

const pathOf = (file: ForgeFile) => file.path;
const noFiles: readonly ForgeFile[] = [];
const noComments: ReadonlyMap<string, number> = new Map();
