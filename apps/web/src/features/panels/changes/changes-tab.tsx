import { useClient, useThreadMeta } from "@ace/client-react";
import { GitDiffIcon } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { countChanges, type FileDiff } from "@ace/ui-core";
import { EmptyState } from "@/components/ui/empty.tsx";
import { VirtualRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { useFileDiffs } from "@/lib/diffs/use-file-diffs.ts";
import { cn } from "@/lib/cn.ts";
import { useElementWidth } from "@/lib/use-element-width.ts";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { ChangesToolbar, type Scope } from "./changes-toolbar.tsx";
import {
  discardDraft,
  draftKey,
  refreshDrafts,
  resolveDraft,
  saveDraft,
  sendDrafts,
  type ReviewDraft,
} from "./drafts.ts";
import { FileActions } from "./file-actions.tsx";
import {
  FileDiffBlock,
  fileHeight,
  freshView,
  type FileView,
  type LineTarget,
} from "./file-diff.tsx";
import { FileTree } from "./file-tree.tsx";
import { CommentComposer, DraftCard } from "./line-comment.tsx";
import { ReviewBar } from "./review-bar.tsx";
import { setViewed } from "./review-store.ts";
import { useTurns } from "@/lib/diffs/use-turns.ts";
import { WorkingTree } from "./working-tree.tsx";

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
  const turns = useTurns(threadId);
  const edited = useMemo(() => turns.filter((turn) => turn.edits.length), [turns]);
  const [scope, setScope] = useState<Scope>("last");
  const prefs = useLocal(services.diffPrefs, identity);
  const allDrafts = useLocal(services.drafts, identity);
  const drafts = useMemo(
    () => allDrafts.filter((draft) => draft.threadId === threadId),
    [allDrafts, threadId],
  );
  const viewedAll = useLocal(services.viewed, identity);
  const viewedHere = viewedAll.get(threadId);
  const [composing, setComposing] = useState<{ file: string; target: LineTarget }>();
  // Per file, by path: kept here so a file scrolled out of a long list and back keeps it.
  const [views, setViews] = useState<ReadonlyMap<string, FileView>>(() => new Map());
  const [current, setCurrent] = useState<string>();
  const blocks = useRef<VirtualRowsHandle>(null);
  const anchor = useId();
  const [measure, width] = useElementWidth();

  // A turn picked before it left the loaded history falls back to the last turn.
  const effective: Scope =
    scope === "all" || edited.some((candidate) => candidate.id === scope) ? scope : "last";
  const turn =
    effective === "all"
      ? undefined
      : (edited.find((candidate) => candidate.id === effective) ?? edited.at(-1));
  const shown = useMemo(
    () => (turn ? turn.edits : edited.flatMap((each) => each.edits)),
    [turn, edited],
  );
  const { files, pending } = useFileDiffs(shown);
  const stat = useMemo(() => countChanges(files.flatMap((file) => file.rows)), [files]);
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

  if (!edited.length)
    return (
      <EmptyState
        icon={GitDiffIcon}
        title="No changes yet"
        description="Edits the agents make in this thread show up here, turn by turn, ready to review and comment on."
      />
    );

  const send = (keys: readonly string[]) => {
    if (thread) void sendDrafts(client, services.drafts, thread, keys);
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
    const find = (target: LineTarget) =>
      forFile.find((draft) => draft.side === target.side && draft.line === target.line);
    const isComposing = (target: LineTarget) =>
      composing?.file === file.path &&
      composing.target.side === target.side &&
      composing.target.line === target.line;
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
        wrap={prefs.wrap}
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
        highlighted={(target) => !!find(target) || isComposing(target)}
        onComment={(target) => setComposing({ file: file.path, target })}
        renderAnnotation={(target) => {
          const draft = find(target);
          const label = `Comment on ${target.side === "old" ? "old " : ""}line ${target.line}`;
          if (isComposing(target))
            return (
              <CommentComposer
                label={label}
                {...textOf(draft)}
                onCancel={() => setComposing(undefined)}
                onSave={(text) => {
                  saveDraft(services.drafts, {
                    threadId,
                    file: file.path,
                    ...target,
                    text,
                    createdAt: Date.now(),
                  });
                  setComposing(undefined);
                }}
              />
            );
          if (!draft) return null;
          return (
            <DraftCard
              draft={draft}
              onSend={() => send([draft.key])}
              onEdit={() => setComposing({ file: file.path, target })}
              onResolve={(resolved) =>
                void resolveDraft(client, services.drafts, draft.key, resolved)
              }
              onDiscard={() =>
                discardDraft(
                  services.drafts,
                  draftKey(threadId, file.path, target.side, target.line),
                )
              }
            />
          );
        }}
      />
    );
  };
  const tree = showTree && (
    <FileTree
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
        scope={effective}
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
      />
      <WorkingTree details={thread?.details} />
      <ReviewBar
        drafts={drafts}
        onSend={send}
        onJump={jump}
        onRefresh={() => refreshDrafts(client, services.drafts, threadId).catch(() => undefined)}
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
const textOf = (draft: ReviewDraft | undefined) => (draft ? { initial: draft.text } : {});
