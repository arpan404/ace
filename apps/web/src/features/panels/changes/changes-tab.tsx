import { useClient, useThreadMeta } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { type FileDiff } from "@ace/ui-core";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.tsx";
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
  sendDrafts,
  type ReviewDraft,
} from "./drafts.ts";
import { displayedSelection } from "./displayed-selection.ts";
import { applySuggestion, setReviewStatus } from "./review-actions.ts";
import { beginComposition, updateComposition, type ReviewComposition } from "./compositions.ts";
import { CompositionEditor } from "./composition-editor.tsx";
import { Button } from "@/components/ui/button.tsx";
import { FileActions } from "./file-actions.tsx";
import {
  FileDiffBlock,
  fileHeight,
  freshView,
  inRange,
  type FileView,
  type LineTarget,
} from "./file-diff.tsx";
import { FileTree } from "./file-tree.tsx";
import { DraftCard, linesLabel } from "./line-comment.tsx";
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
  const { scope, setScope, edited, files, pending, versions, stat } = useScopedDiff(threadId);
  const prefs = useLocal(services.diffPrefs, identity);
  const allDrafts = useLocal(services.drafts, identity);
  const drafts = useMemo(
    () => allDrafts.filter((draft) => draft.threadId === threadId),
    [allDrafts, threadId],
  );
  const viewedAll = useLocal(services.viewed, identity);
  const viewedHere = viewedAll.get(threadId);
  const compositionState = useLocal(services.compositions, identity);
  const unfinished = [...compositionState.entries.values()].filter(
    (entry) => entry.threadId === threadId,
  );
  const composing = compositionState.entries.get(compositionState.active.get(threadId) ?? "");
  const [reselecting, setReselecting] = useState<string>();
  const [compositionError, setCompositionError] = useState<string>();
  const startComposition = (entry: ReviewComposition) => {
    const accepted = beginComposition(services.compositions, entry);
    setCompositionError(
      accepted ? undefined : "Save or cancel an unfinished comment before starting another.",
    );
  };
  useEffect(() => {
    if (
      composing &&
      !composing.needsReselection &&
      composing.version !== versions.get(composing.file)
    ) {
      updateComposition(services.compositions, composing.id, { needsReselection: true });
    }
  }, [composing, versions, services.compositions]);
  const changeScope = (next: Parameters<typeof setScope>[0]) => {
    setReselecting(undefined);
    setScope(next);
  };
  // Per file, by path: kept here so a file scrolled out of a long list and back keeps it.
  const [views, setViews] = useState<ReadonlyMap<string, { version: string; view: FileView }>>(
    () => new Map(),
  );
  const [current, setCurrent] = useState<string>();
  const [selectedComment, setSelectedComment] = useState<string>();
  const selected = drafts.find((draft) => draft.key === selectedComment);
  const blocks = useRef<VirtualRowsHandle>(null);
  const anchor = useId();
  const [measure, width] = useElementWidth();

  const versionOf = (file: FileDiff) => versions.get(file.path) ?? "";
  const rows = files.reduce((sum, file) => sum + file.rows.length, 0);
  const viewed = useMemo(
    () =>
      new Set(
        files
          .filter((file) => viewedHere?.get(file.path) === versions.get(file.path))
          .map((f) => f.path),
      ),
    [files, viewedHere, versions],
  );
  const comments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const draft of drafts)
      if (draft.state !== "resolved") counts.set(draft.file, (counts.get(draft.file) ?? 0) + 1);
    return counts;
  }, [drafts]);
  // A file viewed at this version starts folded; anything opened by hand stays as left.
  const viewOf = (file: FileDiff) =>
    views.get(file.path)?.version === versionOf(file)
      ? (views.get(file.path)?.view ?? freshView)
      : viewed.has(file.path)
        ? { ...freshView, open: false }
        : freshView;
  const setView = (path: string, next: FileView) =>
    setViews((previous) =>
      new Map(previous).set(path, { version: versions.get(path) ?? "", view: next }),
    );

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
  // Opened on a file (a changed-files card): show that file, once
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
        onScope={changeScope}
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

  const renderDraft = (draft: ReviewDraft) => (
    <DraftCard
      key={draft.key}
      draft={draft}
      onSend={() => void send([draft.key])}
      onEdit={() => {
        setSelectedComment(undefined);
        setReselecting(undefined);
        const retained = unfinished.find((entry) => entry.key === draft.key);
        startComposition(
          retained ?? {
            id: crypto.randomUUID(),
            threadId,
            file: draft.file,
            key: draft.key,
            version: versions.get(draft.file) ?? "",
            needsReselection: false,
            fingerprint: draft.fingerprint,
            source: draft.source,
            text: draft.text,
            suggestion: draft.suggestion,
            range: { side: draft.side, start: draft.line, end: draft.end ?? draft.line },
          },
        );
      }}
      onResolve={(resolved) => void resolveDraft(client, services.drafts, draft.key, resolved)}
      onApply={() => thread && void applySuggestion(client, services.drafts, thread, draft.key)}
      onDiscard={() => discardDraft(services.drafts, draft.key)}
    />
  );

  const renderFile = (file: FileDiff, index: number) => {
    const forFile = drafts.filter((draft) => draft.file === file.path);
    // A comment shows under its last line and marks every line it covers.
    const at = (target: LineTarget) =>
      forFile.filter(
        (draft) => draft.side === target.side && (draft.end ?? draft.line) === target.line,
      );
    const composition =
      composing?.file === file.path &&
      !composing.needsReselection &&
      composing.version === versionOf(file)
        ? composing
        : undefined;
    const writing = composition?.range;
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
        highlighted={(target) =>
          inRange(writing, target) ||
          forFile.some((draft) =>
            inRange({ side: draft.side, start: draft.line, end: draft.end ?? draft.line }, target),
          )
        }
        selection={writing}
        onComment={(range) => {
          const evidence = {
            file: file.path,
            range,
            version: versionOf(file),
            needsReselection: false,
            fingerprint: displayedSelection(file, range),
            source: undefined,
          };
          if (composing && reselecting === composing.id) {
            updateComposition(services.compositions, composing.id, evidence);
          } else {
            startComposition({
              ...evidence,
              id: crypto.randomUUID(),
              threadId,
              text: "",
              suggestion: undefined,
            });
          }
          setReselecting(undefined);
        }}
        onExtend={(range) => {
          if (composition)
            updateComposition(services.compositions, composition.id, {
              range,
              fingerprint: displayedSelection(file, range),
              source: undefined,
            });
        }}
        renderAnnotation={(target) => {
          if (
            composition &&
            writing &&
            writing.side === target.side &&
            writing.end === target.line
          ) {
            return (
              <CompositionEditor
                key={composition.id}
                composition={composition}
                onReselect={() => setReselecting(composition.id)}
              />
            );
          }
          return at(target).map((draft) => renderDraft(draft));
        }}
      />
    );
  };
  const detached =
    composing && (composing.needsReselection || composing.version !== versions.get(composing.file));
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
        onScope={changeScope}
        stat={stat}
        prefs={prefs}
        shown={mode}
        splitTooNarrow={splitTooNarrow}
        onPrefs={(change) => services.diffPrefs.set(change)}
        allCollapsed={allCollapsed}
        onCollapseAll={(folded) =>
          setViews(
            new Map(
              files.map((file) => [
                file.path,
                { version: versionOf(file), view: { ...viewOf(file), open: !folded } },
              ]),
            ),
          )
        }
        canShowTree={files.length > 1}
        onRefreshReview={() => void session.refetch()}
      />
      {drafts.length > 0 && (
        <ReviewBar
          drafts={drafts}
          session={session.data ?? undefined}
          onReview={review}
          onSend={(keys) => void send(keys)}
          onJump={(draft) => {
            jump(draft.file);
            setSelectedComment(draft.key);
          }}
        />
      )}
      {compositionError && (
        <p role="alert" className="shrink-0 border-b px-2.5 py-2 text-sm text-subtle-foreground">
          {compositionError}
        </p>
      )}
      {unfinished.some((entry) => entry.id !== composing?.id) && (
        <div
          aria-label="Unfinished review comments"
          className="flex shrink-0 flex-wrap gap-1 border-b px-2.5 py-1"
        >
          {unfinished
            .filter((entry) => entry.id !== composing?.id)
            .map((entry) => (
              <Button
                key={entry.id}
                size="sm"
                variant="ghost"
                onClick={() => {
                  setReselecting(undefined);
                  startComposition(entry);
                }}
              >
                Resume {entry.file}: {entry.text.slice(0, 80) || "unfinished comment"}
              </Button>
            ))}
        </div>
      )}
      {composing && detached && (
        <section
          aria-label="Unfinished review comment"
          className="max-h-[45%] shrink-0 overflow-auto border-b"
        >
          <p className="px-2.5 pt-2 text-xs text-subtle-foreground">{composing.file}</p>
          <CompositionEditor
            key={composing.id}
            composition={composing}
            blocked={
              reselecting === composing.id
                ? "Choose lines in the diff to attach your retained comment."
                : "The displayed file changed. Your draft is kept. Reselect lines before saving."
            }
            onReselect={() => setReselecting(composing.id)}
          />
        </section>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelectedComment(undefined);
        }}
      >
        <DialogContent size="lg">
          <DialogTitle>Review comment</DialogTitle>
          <DialogDescription>
            {selected &&
              `${selected.file}: ${linesLabel(selected.side, selected.line, selected.end)}`}
          </DialogDescription>
          {selected && renderDraft(selected)}
        </DialogContent>
      </Dialog>
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
