import { useClient, useThreadMeta } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { type FileDiff } from "@ace/ui-core";
import { VirtualRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { cn } from "@/lib/cn.ts";
import { useElementWidth } from "@/lib/use-element-width.ts";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { ChangesToolbar } from "./changes-toolbar.tsx";
import {
  discardDraft,
  isPending,
  refreshDrafts,
  resolveDraft,
  saveDraft,
  sendDrafts,
  type ReviewDraft,
} from "./drafts.ts";
import { applySuggestion, setReviewStatus } from "./review-actions.ts";
import { FileActions } from "./file-actions.tsx";
import {
  FileDiffBlock,
  fileHeight,
  freshView,
  inRange,
  type FileView,
  type LineRange,
  type LineTarget,
} from "./file-diff.tsx";
import { FileTree } from "./file-tree.tsx";
import { CommentComposer, DraftCard, linesLabel } from "./line-comment.tsx";
import { ReviewBar } from "./review-bar.tsx";
import { setViewed } from "./review-store.ts";
import { useScopedDiff } from "@/lib/diffs/use-scoped-diff.ts";
import { WorkingTreeDiff } from "./working-tree-diff.tsx";

/** Past this many rows across the files shown, only the files near the viewport mount. */
const virtualRowsAbove = 2_000;
/** Auto layout is split from this diff width, unified below it. */
const splitFrom = 880;
/** The files tree sits beside the diff from this tab width, above it below. */
const treeBesideFrom = 600;
/** The tree's width beside the diff (its `w-[240px]`). */
const treeWidth = 240;
/** A chosen Split needs this much diff width; narrower it shows unified until there is room. */
const splitNeeds = 640;

/** The version of a file's diff that "Viewed" remembers: a later edit changes it. */
const versionOf = (file: FileDiff) => `${file.rows.length}:${file.additions}:${file.deletions}`;

/**
 * Changes: a review surface for what the agents changed, turn by turn. Scope, layout and the
 * files tree in the toolbar; per file, Viewed and its actions; per line, comments that go to the
 * agent through review mode (draft → sent → resolved), summed up in the review bar.
 */
export function ChangesTab(props: { threadId: string; path?: string | undefined }) {
  const { threadId } = props;
  const services = usePanelServices();
  const client = useClient();
  const thread = useThreadMeta(threadId);
  // The thread's reviews on the daemon (from every device and agent), read as the tab opens and
  // as the thread moves on; its newest session is what Approve and Request changes act on.
  const sessionKey = ["review-drafts", threadId, thread?.status.state, thread?.details?.head];
  const session = useDaemonQuery({
    queryKey: sessionKey,
    staleTime: 0,
    retry: false,
    read: (daemon) => refreshDrafts(daemon, services.drafts, threadId),
  });
  const queries = useQueryClient();
  const { scope, setScope, edited, files, pending, stat } = useScopedDiff(threadId);
  const prefs = useLocal(services.diffPrefs, identity);
  const allDrafts = useLocal(services.drafts, identity);
  const drafts = useMemo(
    () => allDrafts.filter((draft) => draft.threadId === threadId),
    [allDrafts, threadId],
  );
  const viewedAll = useLocal(services.viewed, identity);
  const viewedHere = viewedAll.get(threadId);
  const [composing, setComposing] = useState<{ file: string; range: LineRange }>();
  // Per file, by path: kept here so a file scrolled out of a long list and back keeps it.
  const [views, setViews] = useState<ReadonlyMap<string, FileView>>(() => new Map());
  const [current, setCurrent] = useState<string>();
  const blocks = useRef<VirtualRowsHandle>(null);
  const anchor = useId();
  const [measure, width] = useElementWidth();

  const rows = files.reduce((sum, file) => sum + file.rows.length, 0);
  const viewed = useMemo(
    () =>
      new Set(
        files.filter((file) => viewedHere?.get(file.path) === versionOf(file)).map((f) => f.path),
      ),
    [files, viewedHere],
  );
  const comments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const draft of drafts)
      if (draft.state !== "resolved") counts.set(draft.file, (counts.get(draft.file) ?? 0) + 1);
    return counts;
  }, [drafts]);
  // A file viewed at this version starts folded; anything opened by hand stays as left.
  const viewOf = (file: FileDiff) =>
    views.get(file.path) ?? (viewed.has(file.path) ? { ...freshView, open: false } : freshView);
  const setView = (path: string, next: FileView) =>
    setViews((previous) => new Map(previous).set(path, next));

  const jump = (path: string) => {
    const index = files.findIndex((file) => file.path === path);
    if (index < 0) return;
    setCurrent(path);
    const file = files[index];
    if (file && !viewOf(file).open) setView(path, { ...viewOf(file), open: true });
    const block = document.getElementById(`${anchor}-${index}`);
    if (block) block.scrollIntoView?.({ block: "start" });
    else blocks.current?.scrollToIndex(index);
  };
  // Opened on a file (the launcher's Suggested, a changed-files card): show that file, once
  // its diff is ready.
  const ready = files.some((file) => file.path === props.path);
  const jumped = useRef<string>(undefined);
  useEffect(() => {
    if (!props.path || !ready || jumped.current === props.path) return;
    jumped.current = props.path;
    const index = files.findIndex((file) => file.path === props.path);
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- following the tab's request.
    setCurrent(props.path);
    document.getElementById(`${anchor}-${index}`)?.scrollIntoView?.({ block: "start" });
  }, [props.path, ready, files, anchor]);

  if (!edited.length || scope === "working-tree")
    return (
      <WorkingTreeDiff
        threadId={threadId}
        details={thread?.details}
        state={thread?.status.state}
        turns={edited}
        onScope={setScope}
      />
    );

  const send = (keys: readonly string[]) =>
    thread ? sendDrafts(client, services.drafts, thread, keys) : Promise.resolve();
  const review = async (status: "approved" | "changes-requested") => {
    if (!thread) return;
    const unsent = drafts.filter(isPending).map((draft) => draft.key);
    // Requesting changes sends what is still unsent; the daemon marks the review for it.
    if (status === "changes-requested" && unsent.length) await send(unsent);
    else
      queries.setQueryData(sessionKey, await setReviewStatus(client, thread, session.data, status));
  };
  const showTree = prefs.tree && files.length > 1;
  const beside = width >= treeBesideFrom;
  // Two columns of code at ~200px each clip mid-token: a chosen Split waits for the room (the
  // choice is global, so full view's Split mustn't squeeze every 520px panel). 0 is unmeasured.
  const diffWidth = width - (showTree && beside ? treeWidth : 0);
  const splitTooNarrow = prefs.mode === "split" && width > 0 && diffWidth < splitNeeds;
  const mode =
    prefs.mode === "auto"
      ? width >= splitFrom
        ? "split"
        : "unified"
      : splitTooNarrow
        ? "unified"
        : prefs.mode;
  const allCollapsed = files.length > 0 && files.every((file) => !viewOf(file).open);

  const renderFile = (file: FileDiff, index: number) => {
    const forFile = drafts.filter((draft) => draft.file === file.path);
    // A comment shows under its last line and marks every line it covers.
    const at = (target: LineTarget) =>
      forFile.find(
        (draft) => draft.side === target.side && (draft.end ?? draft.line) === target.line,
      );
    const writing = composing?.file === file.path ? composing.range : undefined;
    const view = viewOf(file);
    const isViewed = viewed.has(file.path);
    return (
      <FileDiffBlock
        key={file.path}
        id={`${anchor}-${index}`}
        file={file}
        view={view}
        onView={(next) => setView(file.path, next)}
        mode={mode}
        wrap={width < 640 || prefs.wrap}
        viewed={isViewed}
        actions={
          <FileActions
            path={file.path}
            viewed={isViewed}
            open={view.open}
            onOpen={(open) => setView(file.path, { ...view, open })}
            onViewed={(next) => {
              setViewed(services.viewed, threadId, file.path, next ? versionOf(file) : undefined);
              setView(file.path, { ...view, open: !next });
            }}
          />
        }
        highlighted={(target) =>
          inRange(writing, target) ||
          forFile.some((draft) =>
            inRange({ side: draft.side, start: draft.line, end: draft.end ?? draft.line }, target),
          )
        }
        selection={writing}
        onComment={(range) => setComposing({ file: file.path, range })}
        renderAnnotation={(target) => {
          if (writing && writing.side === target.side && writing.end === target.line) {
            const draft = forFile.find(
              (each) => each.side === writing.side && each.line === writing.start,
            );
            return (
              <CommentComposer
                label={`Comment on ${linesLabel(writing.side, writing.start, writing.end)}`}
                {...textOf(draft)}
                suggestFrom={writing.side === "new" ? linesOf(file, writing) : undefined}
                onCancel={() => setComposing(undefined)}
                onSave={(text, suggestion) => {
                  saveDraft(services.drafts, {
                    threadId,
                    file: file.path,
                    side: writing.side,
                    line: writing.start,
                    ...(writing.end > writing.start ? { end: writing.end } : {}),
                    text,
                    ...(suggestion === undefined ? {} : { suggestion }),
                    createdAt: Date.now(),
                  });
                  setComposing(undefined);
                }}
              />
            );
          }
          const draft = at(target);
          if (!draft) return null;
          return (
            <DraftCard
              draft={draft}
              onSend={() => void send([draft.key])}
              onEdit={() =>
                setComposing({
                  file: file.path,
                  range: { side: draft.side, start: draft.line, end: draft.end ?? draft.line },
                })
              }
              onResolve={(resolved) =>
                void resolveDraft(client, services.drafts, draft.key, resolved)
              }
              onApply={() =>
                thread && void applySuggestion(client, services.drafts, thread, draft.key)
              }
              onDiscard={() => discardDraft(services.drafts, draft.key)}
            />
          );
        }}
      />
    );
  };
  const tree = showTree && (
    <FileTree
      threadId={threadId}
      files={files}
      current={current}
      viewed={viewed}
      comments={comments}
      onJump={(index) => {
        const file = files[index];
        if (file) jump(file.path);
      }}
      className={beside ? "w-[240px] shrink-0 border-l" : "max-h-[40%] shrink-0 border-b"}
    />
  );
  return (
    <div ref={measure} className="flex h-full min-h-0 flex-col">
      <ChangesToolbar
        scope={scope}
        turns={edited}
        onScope={setScope}
        stat={stat}
        prefs={prefs}
        shown={mode}
        splitTooNarrow={splitTooNarrow}
        onPrefs={(change) => services.diffPrefs.set(change)}
        allCollapsed={allCollapsed}
        onCollapseAll={(folded) =>
          setViews(new Map(files.map((file) => [file.path, { ...viewOf(file), open: !folded }])))
        }
        canShowTree={files.length > 1}
        onRefreshReview={() => void session.refetch()}
      />
      <ReviewBar
        drafts={drafts}
        session={session.data ?? undefined}
        onReview={review}
        onSend={(keys) => void send(keys)}
        onJump={jump}
      />
      <div className={cn("flex min-h-0 flex-1", beside ? "flex-row" : "flex-col")}>
        {!beside && tree}
        <div data-diff-scroller="" className="min-h-0 min-w-0 flex-1 overflow-auto pb-8">
          {pending > 0 && (
            <p role="status" className="px-3.5 py-2 text-xs text-subtle-foreground">
              Preparing {pending === 1 ? "1 file" : `${pending} files`}…
            </p>
          )}
          {files.length > 1 && rows > virtualRowsAbove ? (
            <VirtualRows
              items={files}
              rowKey={(file) => file.path}
              estimate={(file) => fileHeight(file, viewOf(file))}
              render={(file, index) => renderFile(file, index)}
              handle={blocks}
            />
          ) : (
            files.map((file, index) => renderFile(file, index))
          )}
        </div>
        {beside && tree}
      </div>
    </div>
  );
}

const identity = <T,>(value: T) => value;
const textOf = (draft: ReviewDraft | undefined) =>
  draft ? { initial: draft.text, initialSuggestion: draft.suggestion } : {};

/** The text of new-side lines in a range, when the diff holds every one of them. */
function linesOf(file: FileDiff, range: LineRange): string | undefined {
  const lines: string[] = [];
  for (const row of file.rows)
    for (const line of row.kind === "fold" ? (row.lines ?? []) : [row])
      if (
        line.kind !== "del" &&
        line.new !== undefined &&
        inRange(range, { side: "new", line: line.new })
      )
        lines.push(line.text);
  return lines.length === range.end - range.start + 1 ? lines.join("\n") : undefined;
}
