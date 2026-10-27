import { useClient, useThreadMeta } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { type FileDiff } from "@ace/ui-core";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useElementWidth } from "@/lib/use-element-width.ts";
import { usePanelServices, type DiffPrefs } from "../services.ts";
import { useLocal } from "../store.ts";
import {
  discardDraft,
  isPending,
  refreshDrafts,
  resolveDraft,
  sendDrafts,
  displayedSelection,
  applySuggestion,
  setReviewStatus,
  type ReviewDraft,
} from "@ace/ui-core/review";
import { beginComposition, updateComposition, type ReviewComposition } from "./compositions.ts";
import { CompositionEditor } from "./composition-editor.tsx";
import { Button } from "@/components/ui/button.tsx";
import { diffLayout, type DiffLayout } from "./diff-layout.ts";
import { DiffFiles, useDiffJump, useFileViews } from "./diff-files.tsx";
import { DraftCard, linesLabel } from "./line-comment.tsx";
import { DraftView, ReviewedFile, useReviewHandlers } from "./reviewed-file.tsx";
import { ReviewBar } from "./review-bar.tsx";
import { setViewed } from "./review-store.ts";

/** Why a turn's diff takes no comments, in words. */
export const turnScopeReason = "Comments go on Uncommitted: a turn's lines can't be anchored.";

export interface SurfaceChrome {
  layout: DiffLayout;
  prefs: DiffPrefs;
  views: ReturnType<typeof useFileViews>;
  /** Read the daemon's reviews again. */
  refreshReview(): void;
}

/**
 * A diff under review (ADR 0038). Per file, Viewed and its actions; on the Uncommitted scope,
 * per line, comments that go to the agent through review mode (draft → sent → resolved),
 * anchored to the working tree's review. A turn's diff is built from the agent's edits, so its
 * line numbers aren't the checkout's: there, comments are only listed, read-only.
 */
export function ReviewSurface(props: {
  threadId: string;
  tabKey?: string | undefined;
  path?: string | undefined;
  files: readonly FileDiff[];
  /** Each file's diff version: viewed marks and open comments hold the one they were made at. */
  versions: ReadonlyMap<string, string>;
  /** The scope is the working tree, the only one comments go on. */
  commentable: boolean;
  /** Names the surface as a region (the Uncommitted diff). */
  label?: string | undefined;
  renderToolbar(chrome: SurfaceChrome): ReactNode;
  notice?: ReactNode;
  /** Shown instead of the files (reading, empty or failed). */
  body?: ReactNode;
}) {
  const { threadId, files, versions, commentable } = props;
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
  const prefs = useLocal(services.diffPrefs, identity);
  const allDrafts = useLocal(services.drafts, identity);
  const drafts = useMemo(
    () => allDrafts.filter((draft) => draft.threadId === threadId),
    [allDrafts, threadId],
  );
  const viewedAll = useLocal(services.viewed, identity);
  const viewedHere = viewedAll.get(threadId);
  const compositionState = useLocal(services.compositions, identity);
  const unfinished = commentable
    ? [...compositionState.entries.values()].filter((entry) => entry.threadId === threadId)
    : [];
  const composing = commentable
    ? compositionState.entries.get(compositionState.active.get(threadId) ?? "")
    : undefined;
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
  const [selectedComment, setSelectedComment] = useState<string>();
  const selected = drafts.find((draft) => draft.key === selectedComment);
  const [measure, width] = useElementWidth();

  const versionOf = (file: FileDiff) => versions.get(file.path) ?? "";
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
    if (commentable)
      for (const draft of drafts)
        if (draft.state !== "resolved") counts.set(draft.file, (counts.get(draft.file) ?? 0) + 1);
    return counts;
  }, [drafts, commentable]);
  // Each file's comments as one array, so a file whose comments didn't change keeps its block.
  const draftsByFile = useMemo(() => {
    const byFile = new Map<string, ReviewDraft[]>();
    if (commentable)
      for (const draft of drafts)
        byFile.set(draft.file, [...(byFile.get(draft.file) ?? []), draft]);
    return byFile;
  }, [drafts, commentable]);
  // A file viewed at this version starts folded; anything opened by hand stays as left.
  const views = useFileViews(files, versions, viewed);
  const jump = useDiffJump(files, views, props.path);

  const send = (keys: readonly string[]) =>
    thread ? sendDrafts(client, services.drafts, thread, keys, newCommandId) : Promise.resolve();
  const handlers = useReviewHandlers({
    setView: views.setView,
    setViewed: (file, next, view) => {
      setViewed(services.viewed, threadId, file.path, next ? versionOf(file) : undefined);
      views.setView(file.path, { ...view, open: !next });
    },
    comment: (file, range) => {
      if (!commentable) return;
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
    },
    extend: (composition, file, range) =>
      updateComposition(services.compositions, composition.id, {
        range,
        fingerprint: displayedSelection(file, range),
        source: undefined,
      }),
    reselect: (id) => setReselecting(id),
    send: (key) => void send([key]),
    edit: (draft) => {
      if (!commentable) return;
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
    },
    resolve: (key, resolved) => void resolveDraft(client, services.drafts, key, resolved),
    apply: (key) => {
      if (thread) void applySuggestion(client, services.drafts, thread, key, newCommandId);
    },
    discard: (key) => discardDraft(services.drafts, key),
  });

  const review = async (status: "approved" | "changes-requested") => {
    if (!thread) return;
    const unsent = drafts.filter(isPending).map((draft) => draft.key);
    // Requesting changes sends what is still unsent; the daemon marks the review for it.
    if (status === "changes-requested" && unsent.length) await send(unsent);
    else
      queries.setQueryData(sessionKey, await setReviewStatus(client, thread, session.data, status));
  };
  const layout = diffLayout(width, prefs, files.length);

  const renderFile = (file: FileDiff, index: number) => {
    const composition =
      composing?.file === file.path &&
      !composing.needsReselection &&
      composing.version === versionOf(file)
        ? composing
        : undefined;
    return (
      <ReviewedFile
        key={file.path}
        id={`${jump.anchor}-${index}`}
        threadId={threadId}
        file={file}
        view={views.viewOf(file)}
        mode={layout.mode}
        wrap={prefs.wrap}
        viewed={viewed.has(file.path)}
        drafts={draftsByFile.get(file.path) ?? noDrafts}
        composition={composition}
        commentable={commentable}
        handlers={handlers}
      />
    );
  };
  const detached =
    composing && (composing.needsReselection || composing.version !== versions.get(composing.file));
  return (
    <div
      ref={measure}
      className="flex h-full min-h-0 flex-col"
      {...(props.label ? { role: "region", "aria-label": props.label } : {})}
    >
      {props.renderToolbar({ layout, prefs, views, refreshReview: () => void session.refetch() })}
      {drafts.length > 0 && (
        <ReviewBar
          drafts={drafts}
          session={session.data ?? undefined}
          onReview={review}
          onSend={(keys) => void send(keys)}
          onJump={(draft) => {
            if (commentable) jump.jump(draft.file);
            setSelectedComment(draft.key);
          }}
        />
      )}
      {!commentable && (
        <p role="note" className="shrink-0 border-b px-3.5 py-2 text-xs text-subtle-foreground">
          {turnScopeReason}
        </p>
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
          {selected &&
            (commentable ? (
              <DraftView draft={selected} handlers={handlers} />
            ) : (
              <DraftCard draft={selected} />
            ))}
        </DialogContent>
      </Dialog>
      {props.body ?? (
        <DiffFiles
          threadId={threadId}
          tabKey={props.tabKey}
          files={files}
          layout={layout}
          jump={jump}
          viewOf={views.viewOf}
          viewed={viewed}
          comments={comments}
          notice={props.notice}
          renderFile={renderFile}
        />
      )}
    </div>
  );
}

const identity = <T,>(value: T) => value;
const noDrafts: readonly ReviewDraft[] = [];
const newCommandId = () => crypto.randomUUID();
