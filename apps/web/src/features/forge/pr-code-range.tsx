import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { ForgeFile } from "@ace/protocol";
import {
  codeCaveats,
  hostedFileShow,
  renderedKind,
  type CodeRange,
  type CodeScope,
  type SinceLastReview,
} from "@ace/ui-core";
import { useFileChanges } from "@/lib/diffs/use-file-diffs.ts";
import { VirtualRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { fileHeight, freshView, useFileViews } from "@/features/panels/index.ts";
import type { usePrCommits } from "./pr-commits.tsx";
import { hostedFileChanges, offDiffThreads, type SideTexts } from "./pr-code-model.ts";
import { PrCodeFile, type HostedFileRead } from "./pr-code-file.tsx";
import { sideTexts, usePrFileSides } from "./pr-file-sides.ts";
import { PrCodeToolbar } from "./pr-code-toolbar.tsx";
import type { CodeOptions } from "./pr-code-options.ts";
import type { PrDiffContext } from "./pr-extensions.ts";
import { usePrFilePages } from "./pr-file-pages.ts";
import { PrMoreFiles } from "./pr-more-files.tsx";
import { PrOffDiffThreads } from "./pr-off-diff-threads.tsx";
import { usePrViewedMarks } from "./pr-viewed-marks.ts";
import { usePrReview } from "./pr-review-context.tsx";
import { useCodeNavigation } from "./pr-code-nav.ts";
import { codeThreadStops, shownDiffs, threadsAtHead } from "./pr-code-shown.ts";
import { PrCodeTree } from "./pr-code-tree.tsx";
import { prCodeShortcut } from "./pr-shortcuts.ts";
import type { PrFilesProps } from "./pr-files.tsx";

/** Past this many diff rows across the files read, only the files near the viewport mount. */
const virtualRowsAbove = 2_000;

/**
 * One range of the Code tab (All commits, one commit or a span, at one head): its files read
 * page by page, their diffs, conversations and Viewed marks. A push or another commit choice
 * mounts a new one; `place` says which file to open at.
 */
export function PrCodeRange(
  props: PrFilesProps & {
    range: CodeRange;
    scope: CodeScope;
    onScope(scope: CodeScope): void;
    since: SinceLastReview | undefined;
    commits: ReturnType<typeof usePrCommits>;
    options: CodeOptions;
    onOptions(change: Partial<CodeOptions>): void;
    /** The file last read before this range mounted (a push), opened again once found. */
    place: string | undefined;
    onPlace(path: string): void;
    pushedAt: number | undefined;
  },
) {
  const { detail, options } = props;
  const scope = `forge:${props.workspaceId}`;
  const pages = usePrFilePages({
    ...props,
    commit: props.range.commit,
    since: props.range.since,
  });
  const range = pages.range;
  const files = range?.files ?? noFiles;
  // Files whose two sides are read: withheld patches as they near the viewport (or when asked),
  // rendered documents, and files whose folds were opened.
  const [wanted, setWanted] = useState<ReadonlySet<string>>(noPaths);
  const want = useCallback(
    (path: string) =>
      setWanted((previous) => (previous.has(path) ? previous : new Set(previous).add(path))),
    [],
  );
  // Markdown and notebooks draw rendered, except where conversations sit on their lines (and in
  // the review being written): those show their source diff. A file the person switched keeps
  // their choice, whatever conversations come and go.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(noChoices);
  const review = usePrReview();
  const discussed = useMemo(
    () =>
      new Set([
        ...detail.status.reviewThreads.filter((t) => !t.outdated).map((t) => t.file),
        ...(review?.state?.drafts ?? []).map((d) => d.anchor.path),
      ]),
    [detail.status.reviewThreads, review?.state?.drafts],
  );
  const read = usePrFileSides({
    workspaceId: props.workspaceId,
    repository: props.repository,
    range,
    files,
    wanted,
  });
  const texts = useMemo(() => sideTexts(read.sides), [read.sides]);
  // A withheld patch is diffed from both sides; a patch GitHub sent stays its own, and the
  // sides only fill its folds.
  const whole = useMemo(() => {
    const kept = new Map<string, { oldText: string | null; newText: string | null }>();
    for (const file of files) {
      const text = texts.get(file.path);
      if (text && hostedFileShow(file) !== "patch") kept.set(file.path, text);
    }
    return kept as SideTexts;
  }, [files, texts]);
  const inputs = useMemo(() => hostedFileChanges(files, whole), [files, whole]);
  const diffs = useFileChanges(inputs);
  const shown = useMemo(
    () => shownDiffs(diffs.files, files, texts, options.hideWhitespace),
    [diffs.files, files, texts, options.hideWhitespace],
  );
  const byPath = useMemo(() => new Map(shown.map((diff) => [diff.path, diff])), [shown]);
  const context: PrDiffContext | undefined = range && { ...props.context, files: range };
  const marks = usePrViewedMarks(context);
  const markByPath = new Map(files.map((file) => [file.path, marks.markOf(file)]));
  // A file marked viewed folds; unmarking it, a new version of its diff, or hiding whitespace
  // (which renumbers its rows) opens it again.
  const versions = new Map(
    files.map((file) => [
      file.path,
      `${diffs.versions.get(file.path) ?? ""}:${markByPath.get(file.path)?.checked ? "viewed" : ""}:${options.hideWhitespace ? "w" : ""}`,
    ]),
  );
  const folded = new Set(files.filter((file) => markByPath.get(file.path)?.checked).map(pathOf));
  const views = useFileViews(shown, versions, folded);
  // Folds opened before their lines were read show open once they are.
  const [opening, setOpening] = useState<ReadonlyMap<string, number>>(noOpening);
  const viewOf = (diff: (typeof shown)[number]) => {
    const view = views.viewOf(diff);
    const index = opening.get(diff.path);
    const row = index === undefined ? undefined : diff.rows[index];
    if (index === undefined || row?.kind !== "fold" || !row.lines || view.expanded.has(index))
      return view;
    return { ...view, expanded: new Set(view.expanded).add(index) };
  };
  const scroller = useRef<HTMLDivElement>(null);
  const blocks = useRef<VirtualRowsHandle>(null);
  const anchor = `pr-file-${props.range.since ?? ""}${props.range.commit || "all"}`;
  const show = (path: string) => {
    const index = files.findIndex((file) => file.path === path);
    if (index < 0) return false;
    const diff = byPath.get(path);
    if (diff && !viewOf(diff).open) views.setView(path, { ...viewOf(diff), open: true });
    const block = document.getElementById(`${anchor}-${index}`);
    if (block) block.scrollIntoView?.({ block: "start" });
    else blocks.current?.scrollToIndex(index);
    return true;
  };
  const nav = useCodeNavigation({
    files,
    more: pages.more,
    loadMore: pages.loadMore,
    show,
    scroller,
    anchor,
    onPlace: props.onPlace,
  });
  // A file picked elsewhere (the Summary's Changes), or the one being read before a push,
  // opens here once it is found, reading pages until it is.
  const focused = useRef(0);
  const focus = props.focus;
  const restored = useRef(false);
  // Read once: the place as this range opened, not as the person scrolls it.
  const [place] = useState(props.place);
  const ready = files.length > 0;
  useEffect(() => {
    if (!ready) return;
    if (focus && focused.current !== focus.seq) {
      focused.current = focus.seq;
      restored.current = true;
      nav.go(focus.path);
    } else if (!restored.current) {
      restored.current = true;
      if (place && place !== files[0]?.path) nav.go(place);
    }
  });
  const complete = pages.more === "done";
  const caveats = codeCaveats({
    viewed: marks.availability,
    truncated: range?.truncated ?? false,
    commitsTruncated: props.commits.data?.truncated ?? false,
  });
  if (props.commits.error) caveats.push("Couldn't read the commit list.");
  const atHead = range?.headSha === detail.status.headSha;
  if (range?.commit && !atHead)
    caveats.push("Conversations show on All commits and on commits through the latest one.");
  const placeable = useMemo(
    () => threadsAtHead(detail.status.reviewThreads, range, detail.status.headSha),
    [detail.status.reviewThreads, range, detail.status.headSha],
  );
  const offDiff = props.range.commit
    ? []
    : offDiffThreads(detail.status.reviewThreads, { files, diffs: shown, complete });
  const stops = codeThreadStops(offDiff, files, byPath, placeable);
  // A single commit's total is known only once its pages are read; the PR's comes with it.
  const fileCount = props.range.commit ? files.length : detail.changedFiles;
  const rows = shown.reduce((sum, diff) => sum + diff.rows.length, 0);
  const readOf = (file: ForgeFile): HostedFileRead => ({
    show: hostedFileShow(file),
    rendered: renderedKind(file.path),
    source: chosen.get(file.path) ?? discussed.has(file.path),
    onSource: (source) => setChosen((previous) => new Map(previous).set(file.path, source)),
    sides: read.sides.get(file.path),
    root: scroller,
    onWant: () => want(file.path),
    onRetry: read.retry,
  });
  const onOpenFold = (path: string, index: number) => {
    want(path);
    setOpening((previous) => new Map(previous).set(path, index));
  };
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
          threads={placeable.get(file.path)}
          view={diff ? viewOf(diff) : freshView}
          onView={(next) => views.setView(file.path, next)}
          mode={options.mode}
          wrap={options.wrap}
          mark={markByPath.get(file.path)}
          read={readOf(file)}
          onOpenFold={
            hostedFileShow(file) === "patch" && file.patch
              ? (fold) => onOpenFold(file.path, fold)
              : undefined
          }
        />
      )
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const key = prCodeShortcut(event);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === "next-file") nav.stepFile(1);
    else if (key === "previous-file") nav.stepFile(-1);
    else if (key === "next-comment") nav.stepThread(stops, 1, false);
    else if (key === "previous-comment") nav.stepThread(stops, -1, false);
    else if (key === "next-unresolved") nav.stepThread(stops, 1, true);
    else if (key === "toggle-viewed") {
      const mark = nav.current ? markByPath.get(nav.current) : undefined;
      if (mark && !mark.disabled) mark.change(!mark.checked);
    } else {
      const at = Math.max(
        0,
        files.findIndex((file) => file.path === nav.current),
      );
      const next = [...files.slice(at + 1), ...files.slice(0, at)].find(
        (file) => markByPath.get(file.path)?.checked === false,
      );
      if (next) nav.go(next.path);
    }
  };
  return (
    <section
      aria-label="Hosted PR diff"
      data-pr-code=""
      className="@container/code flex h-full min-h-0 min-w-0 flex-col"
      onKeyDown={onKeyDown}
    >
      <PrCodeToolbar
        scope={props.scope}
        commits={props.commits.data?.commits ?? []}
        since={props.since}
        onScope={props.onScope}
        files={fileCount}
        viewed={marks.count}
        caveats={caveats}
        options={options}
        onOptions={props.onOptions}
        allCollapsed={views.allCollapsed}
        onCollapseAll={views.collapseAll}
        pushedAt={props.pushedAt}
        onNextComment={stops.length ? () => nav.stepThread(stops, 1, false) : undefined}
        onNextFile={() => nav.stepFile(1)}
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
      {pages.pending && (
        <LoadingRegion label="changed files" className="flex flex-col gap-3 p-3.5">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-8 w-full rounded-md" />
          ))}
        </LoadingRegion>
      )}
      {range && context && (
        <>
          <PrOffDiffThreads threads={offDiff} />
          <div className="flex min-h-0 flex-1">
            {options.tree && (
              <PrCodeTree
                scope={scope}
                detail={detail}
                files={files}
                all={!props.range.commit}
                current={nav.current}
                marks={markByPath}
                threads={placeable}
                count={fileCount}
                onJump={nav.go}
              />
            )}
            <div
              ref={scroller}
              data-diff-scroller=""
              className="min-h-0 min-w-0 flex-1 overflow-auto pb-16"
            >
              <p className="sr-only">
                {props.range.commit
                  ? "Commits compared with the commit before them"
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
                      return diff ? fileHeight(diff, viewOf(diff)) : 32;
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
              {nav.seeking && (
                <p role="status" className="px-3.5 py-2 text-xs text-muted-foreground">
                  {`Finding ${nav.seeking}…`}
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
          </div>
        </>
      )}
    </section>
  );
}

const pathOf = (file: ForgeFile) => file.path;
const noFiles: readonly ForgeFile[] = [];
const noPaths: ReadonlySet<string> = new Set();
const noChoices: ReadonlyMap<string, boolean> = new Map();
const noOpening: ReadonlyMap<string, number> = new Map();
