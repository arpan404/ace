import type { ChangeContent, ContextContent, FileDiffMetadata, Hunk } from "@pierre/diffs";
import { ArrowUpRightIcon, MessageSquarePlusIcon, PlusIcon, XIcon } from "lucide-react";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";

import {
  createPlainWorkspaceShikiHtmlLines,
  highlightWorkspaceShikiHtmlLines,
} from "~/lib/editor/workspaceShikiHighlight";
import {
  createWorkspaceCodeComment,
  type WorkspaceCodeComment,
} from "~/lib/editor/workspaceDesigner";
import { renderTrustedHighlightedHtml } from "~/components/TrustedHighlightedHtml";
import { useWorkspaceCommentPlaceholder } from "~/lib/editor/workspaceCommentPlaceholders";
import {
  APP_FLOATING_CHIP_CLASS_NAME,
  APP_FLOATING_TOOLBAR_CLASS_NAME,
  APP_WORKSPACE_INSET_CLASS_NAME,
} from "~/lib/appChrome";
import { cn } from "~/lib/utils";

type WorkspaceReviewDiffRenderMode = "stacked" | "split";
type WorkspaceReviewCommentAnchor = "left" | "right" | "unified";

interface WorkspaceReviewDiffProps {
  readonly codeComments: readonly WorkspaceCodeComment[];
  readonly cwd: string | null;
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly onAddCodeComment?: (comment: WorkspaceCodeComment) => void;
  readonly renderMode: WorkspaceReviewDiffRenderMode;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
}

interface WorkspaceReviewDiffHighlights {
  readonly additions: readonly string[];
  readonly deletions: readonly string[];
}

interface WorkspaceReviewDiffLineProps {
  readonly activeCommentTargetId: string | null;
  readonly comments: readonly WorkspaceCodeComment[];
  readonly commentDraft: string;
  readonly commentTarget: WorkspaceReviewDiffCommentTarget | null;
  readonly html: string | undefined;
  readonly kind: "addition" | "context" | "deletion" | "empty";
  readonly lineNumber: number | null;
  readonly onCancelComment: () => void;
  readonly onCommentDraftChange: (draft: string) => void;
  readonly onOpenComment: (
    target: WorkspaceReviewDiffCommentTarget,
    anchorElement: HTMLElement,
  ) => void;
  readonly onSubmitComment: () => void;
  readonly wordWrap: boolean;
}

interface WorkspaceReviewDiffSplitLineProps {
  readonly activeCommentTargetId: string | null;
  readonly commentDraft: string;
  readonly leftComments: readonly WorkspaceCodeComment[];
  readonly leftCommentTarget: WorkspaceReviewDiffCommentTarget | null;
  readonly leftHtml: string | undefined;
  readonly leftKind: WorkspaceReviewDiffLineProps["kind"];
  readonly leftLineNumber: number | null;
  readonly onCancelComment: () => void;
  readonly onCommentDraftChange: (draft: string) => void;
  readonly onOpenComment: (
    target: WorkspaceReviewDiffCommentTarget,
    anchorElement: HTMLElement,
  ) => void;
  readonly onSubmitComment: () => void;
  readonly rightComments: readonly WorkspaceCodeComment[];
  readonly rightCommentTarget: WorkspaceReviewDiffCommentTarget | null;
  readonly rightHtml: string | undefined;
  readonly rightKind: WorkspaceReviewDiffLineProps["kind"];
  readonly rightLineNumber: number | null;
  readonly wordWrap: boolean;
}

interface WorkspaceReviewDiffCommentTarget {
  readonly anchor: WorkspaceReviewCommentAnchor;
  readonly code: string;
  readonly id: string;
  readonly lineNumber: number;
  readonly relativePath: string;
  readonly side: "addition" | "deletion";
}

interface WorkspaceReviewDiffRenderProps {
  readonly activeCommentTargetId: string | null;
  readonly commentDraft: string;
  readonly commentsByLineKey: ReadonlyMap<string, readonly WorkspaceCodeComment[]>;
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly highlightedLines: WorkspaceReviewDiffHighlights;
  readonly onCancelComment: () => void;
  readonly onCommentDraftChange: (draft: string) => void;
  readonly onOpenComment: (
    target: WorkspaceReviewDiffCommentTarget,
    anchorElement: HTMLElement,
  ) => void;
  readonly onSubmitComment: () => void;
  readonly previousFilePath: string;
  readonly wordWrap: boolean;
}

function WorkspaceReviewDiff(props: WorkspaceReviewDiffProps) {
  const highlightKey = `${props.fileDiff.cacheKey ?? props.filePath}:${props.resolvedTheme}`;
  const plainHighlightedLines: WorkspaceReviewDiffHighlights = {
    additions: createPlainWorkspaceShikiHtmlLines(props.fileDiff.additionLines),
    deletions: createPlainWorkspaceShikiHtmlLines(props.fileDiff.deletionLines),
  };
  const [highlightedLinesState, setHighlightedLinesState] = useState<{
    key: string;
    highlightedLines: WorkspaceReviewDiffHighlights;
  } | null>(null);
  const highlightedLines =
    highlightedLinesState?.key === highlightKey
      ? highlightedLinesState.highlightedLines
      : plainHighlightedLines;
  const [commentTarget, setCommentTarget] = useState<WorkspaceReviewDiffCommentTarget | null>(null);
  const [commentDraft, setCommentDraft] = useState("");

  const commentsByLineKey = useMemo(() => {
    const next = new Map<string, WorkspaceCodeComment[]>();
    for (const comment of props.codeComments) {
      if (comment.status === "resolved") {
        continue;
      }
      const key = createWorkspaceReviewDiffLineCommentKey(
        comment.relativePath,
        comment.range.startLine + 1,
      );
      const comments = next.get(key);
      if (comments) {
        comments.push(comment);
      } else {
        next.set(key, [comment]);
      }
    }
    return next;
  }, [props.codeComments]);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      highlightWorkspaceShikiHtmlLines({
        filePath: props.filePath,
        lines: props.fileDiff.additionLines,
        resolvedTheme: props.resolvedTheme,
      }),
      highlightWorkspaceShikiHtmlLines({
        filePath: props.fileDiff.prevName ?? props.filePath,
        lines: props.fileDiff.deletionLines,
        resolvedTheme: props.resolvedTheme,
      }),
    ]).then(([additions, deletions]) => {
      if (!cancelled) {
        setHighlightedLinesState({
          key: highlightKey,
          highlightedLines: { additions, deletions },
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [highlightKey, props.fileDiff, props.filePath, props.resolvedTheme]);

  const renderKey = `${props.fileDiff.cacheKey ?? props.filePath}:${props.renderMode}:${
    props.wordWrap ? "wrap" : "scroll"
  }`;
  const openCommentPopover = (
    target: WorkspaceReviewDiffCommentTarget,
    _anchorElement: HTMLElement,
  ) => {
    setCommentTarget(target);
  };

  const closeCommentPopover = () => {
    setCommentDraft("");
    setCommentTarget(null);
  };

  const submitComment = () => {
    const body = commentDraft.trim();
    if (!body || !commentTarget || !props.cwd || !props.onAddCodeComment) {
      return;
    }
    props.onAddCodeComment(
      createWorkspaceCodeComment({
        body,
        code: commentTarget.code,
        createdAt: new Date().toISOString(),
        cwd: props.cwd,
        id:
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `review-comment-${Date.now().toString(36)}`,
        range: {
          endColumn: commentTarget.code.length,
          endLine: Math.max(0, commentTarget.lineNumber - 1),
          relativePath: commentTarget.relativePath,
          startColumn: 0,
          startLine: Math.max(0, commentTarget.lineNumber - 1),
        },
      }),
    );
    closeCommentPopover();
  };

  return (
    <div
      key={renderKey}
      className={cn(
        "relative h-full min-h-0 overflow-auto bg-background font-mono text-[12.5px] leading-[1.65]",
        props.wordWrap ? "overflow-x-hidden" : "overflow-x-auto",
      )}
    >
      <div className={cn("min-w-full py-1", props.wordWrap ? "w-full" : "w-max")}>
        {props.renderMode === "split" ? (
          <WorkspaceReviewSplitDiff
            activeCommentTargetId={commentTarget?.id ?? null}
            commentDraft={commentDraft}
            commentsByLineKey={commentsByLineKey}
            fileDiff={props.fileDiff}
            filePath={props.filePath}
            highlightedLines={highlightedLines}
            onCancelComment={closeCommentPopover}
            onCommentDraftChange={setCommentDraft}
            onOpenComment={openCommentPopover}
            onSubmitComment={submitComment}
            previousFilePath={props.fileDiff.prevName ?? props.filePath}
            wordWrap={props.wordWrap}
          />
        ) : (
          <WorkspaceReviewUnifiedDiff
            activeCommentTargetId={commentTarget?.id ?? null}
            commentDraft={commentDraft}
            commentsByLineKey={commentsByLineKey}
            fileDiff={props.fileDiff}
            filePath={props.filePath}
            highlightedLines={highlightedLines}
            onCancelComment={closeCommentPopover}
            onCommentDraftChange={setCommentDraft}
            onOpenComment={openCommentPopover}
            onSubmitComment={submitComment}
            previousFilePath={props.fileDiff.prevName ?? props.filePath}
            wordWrap={props.wordWrap}
          />
        )}
      </div>
    </div>
  );
}

function WorkspaceReviewUnifiedDiff(props: WorkspaceReviewDiffRenderProps) {
  return (
    <>
      {props.fileDiff.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.hunkSpecs ?? hunkIndex}:unified`}>
          <WorkspaceReviewDiffHunkSeparator hunk={hunk} />
          {hunk.hunkContent.map((content, contentIndex) => {
            if (content.type === "context") {
              return renderUnifiedContextContent({
                content,
                hunk,
                key: `${hunkIndex}:${contentIndex}:context`,
                props,
              });
            }

            return renderUnifiedChangeContent({
              content,
              hunk,
              key: `${hunkIndex}:${contentIndex}:change`,
              props,
            });
          })}
        </div>
      ))}
    </>
  );
}

function WorkspaceReviewSplitDiff(props: WorkspaceReviewDiffRenderProps) {
  return (
    <>
      {props.fileDiff.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.hunkSpecs ?? hunkIndex}:split`}>
          <WorkspaceReviewDiffHunkSeparator hunk={hunk} split />
          {hunk.hunkContent.map((content, contentIndex) => {
            if (content.type === "context") {
              return renderSplitContextContent({
                content,
                hunk,
                key: `${hunkIndex}:${contentIndex}:context`,
                props,
              });
            }

            return renderSplitChangeContent({
              content,
              hunk,
              key: `${hunkIndex}:${contentIndex}:change`,
              props,
            });
          })}
        </div>
      ))}
    </>
  );
}

function renderUnifiedContextContent(input: {
  readonly content: ContextContent;
  readonly hunk: Hunk;
  readonly key: string;
  readonly props: WorkspaceReviewDiffRenderProps;
}) {
  return Array.from({ length: input.content.lines }, (_, index) => {
    const additionIndex = input.content.additionLineIndex + index;
    const lineNumber = getAdditionLineNumber(input.hunk, additionIndex);
    const rawLine = input.props.fileDiff.additionLines[additionIndex] ?? "";
    return (
      <WorkspaceReviewDiffLine
        key={`${input.key}:${index}`}
        activeCommentTargetId={input.props.activeCommentTargetId}
        commentDraft={input.props.commentDraft}
        comments={getWorkspaceReviewDiffLineComments(
          input.props.commentsByLineKey,
          input.props.filePath,
          lineNumber,
        )}
        commentTarget={createWorkspaceReviewDiffCommentTarget({
          anchor: "unified",
          code: stripWorkspaceReviewDiffLineEnding(rawLine),
          lineNumber,
          relativePath: input.props.filePath,
          side: "addition",
        })}
        html={input.props.highlightedLines.additions[additionIndex]}
        kind="context"
        lineNumber={lineNumber}
        onCancelComment={input.props.onCancelComment}
        onCommentDraftChange={input.props.onCommentDraftChange}
        onOpenComment={input.props.onOpenComment}
        onSubmitComment={input.props.onSubmitComment}
        wordWrap={input.props.wordWrap}
      />
    );
  });
}

function renderUnifiedChangeContent(input: {
  readonly content: ChangeContent;
  readonly hunk: Hunk;
  readonly key: string;
  readonly props: WorkspaceReviewDiffRenderProps;
}) {
  const rows = [];
  for (let index = 0; index < input.content.deletions; index += 1) {
    const deletionIndex = input.content.deletionLineIndex + index;
    const lineNumber = getDeletionLineNumber(input.hunk, deletionIndex);
    const rawLine = input.props.fileDiff.deletionLines[deletionIndex] ?? "";
    rows.push(
      <WorkspaceReviewDiffLine
        key={`${input.key}:deletion:${index}`}
        activeCommentTargetId={input.props.activeCommentTargetId}
        commentDraft={input.props.commentDraft}
        comments={getWorkspaceReviewDiffLineComments(
          input.props.commentsByLineKey,
          input.props.previousFilePath,
          lineNumber,
        )}
        commentTarget={createWorkspaceReviewDiffCommentTarget({
          anchor: "unified",
          code: stripWorkspaceReviewDiffLineEnding(rawLine),
          lineNumber,
          relativePath: input.props.previousFilePath,
          side: "deletion",
        })}
        html={input.props.highlightedLines.deletions[deletionIndex]}
        kind="deletion"
        lineNumber={lineNumber}
        onCancelComment={input.props.onCancelComment}
        onCommentDraftChange={input.props.onCommentDraftChange}
        onOpenComment={input.props.onOpenComment}
        onSubmitComment={input.props.onSubmitComment}
        wordWrap={input.props.wordWrap}
      />,
    );
  }
  for (let index = 0; index < input.content.additions; index += 1) {
    const additionIndex = input.content.additionLineIndex + index;
    const lineNumber = getAdditionLineNumber(input.hunk, additionIndex);
    const rawLine = input.props.fileDiff.additionLines[additionIndex] ?? "";
    rows.push(
      <WorkspaceReviewDiffLine
        key={`${input.key}:addition:${index}`}
        activeCommentTargetId={input.props.activeCommentTargetId}
        commentDraft={input.props.commentDraft}
        comments={getWorkspaceReviewDiffLineComments(
          input.props.commentsByLineKey,
          input.props.filePath,
          lineNumber,
        )}
        commentTarget={createWorkspaceReviewDiffCommentTarget({
          anchor: "unified",
          code: stripWorkspaceReviewDiffLineEnding(rawLine),
          lineNumber,
          relativePath: input.props.filePath,
          side: "addition",
        })}
        html={input.props.highlightedLines.additions[additionIndex]}
        kind="addition"
        lineNumber={lineNumber}
        onCancelComment={input.props.onCancelComment}
        onCommentDraftChange={input.props.onCommentDraftChange}
        onOpenComment={input.props.onOpenComment}
        onSubmitComment={input.props.onSubmitComment}
        wordWrap={input.props.wordWrap}
      />,
    );
  }
  return rows;
}

function renderSplitContextContent(input: {
  readonly content: ContextContent;
  readonly hunk: Hunk;
  readonly key: string;
  readonly props: WorkspaceReviewDiffRenderProps;
}) {
  return Array.from({ length: input.content.lines }, (_, index) => {
    const deletionIndex = input.content.deletionLineIndex + index;
    const additionIndex = input.content.additionLineIndex + index;
    const deletionLineNumber = getDeletionLineNumber(input.hunk, deletionIndex);
    const additionLineNumber = getAdditionLineNumber(input.hunk, additionIndex);
    return (
      <WorkspaceReviewDiffSplitLine
        key={`${input.key}:${index}`}
        activeCommentTargetId={input.props.activeCommentTargetId}
        commentDraft={input.props.commentDraft}
        leftComments={getWorkspaceReviewDiffLineComments(
          input.props.commentsByLineKey,
          input.props.previousFilePath,
          deletionLineNumber,
        )}
        leftCommentTarget={createWorkspaceReviewDiffCommentTarget({
          anchor: "left",
          code: stripWorkspaceReviewDiffLineEnding(
            input.props.fileDiff.deletionLines[deletionIndex] ?? "",
          ),
          lineNumber: deletionLineNumber,
          relativePath: input.props.previousFilePath,
          side: "deletion",
        })}
        leftHtml={input.props.highlightedLines.deletions[deletionIndex]}
        leftKind="context"
        leftLineNumber={deletionLineNumber}
        onCancelComment={input.props.onCancelComment}
        onCommentDraftChange={input.props.onCommentDraftChange}
        onOpenComment={input.props.onOpenComment}
        onSubmitComment={input.props.onSubmitComment}
        rightComments={getWorkspaceReviewDiffLineComments(
          input.props.commentsByLineKey,
          input.props.filePath,
          additionLineNumber,
        )}
        rightCommentTarget={createWorkspaceReviewDiffCommentTarget({
          anchor: "right",
          code: stripWorkspaceReviewDiffLineEnding(
            input.props.fileDiff.additionLines[additionIndex] ?? "",
          ),
          lineNumber: additionLineNumber,
          relativePath: input.props.filePath,
          side: "addition",
        })}
        rightHtml={input.props.highlightedLines.additions[additionIndex]}
        rightKind="context"
        rightLineNumber={additionLineNumber}
        wordWrap={input.props.wordWrap}
      />
    );
  });
}

function renderSplitChangeContent(input: {
  readonly content: ChangeContent;
  readonly hunk: Hunk;
  readonly key: string;
  readonly props: WorkspaceReviewDiffRenderProps;
}) {
  const rowCount = Math.max(input.content.deletions, input.content.additions);
  return Array.from({ length: rowCount }, (_, index) => {
    const hasDeletion = index < input.content.deletions;
    const hasAddition = index < input.content.additions;
    const deletionIndex = input.content.deletionLineIndex + index;
    const additionIndex = input.content.additionLineIndex + index;
    const deletionLineNumber = hasDeletion
      ? getDeletionLineNumber(input.hunk, deletionIndex)
      : null;
    const additionLineNumber = hasAddition
      ? getAdditionLineNumber(input.hunk, additionIndex)
      : null;
    return (
      <WorkspaceReviewDiffSplitLine
        key={`${input.key}:${index}`}
        activeCommentTargetId={input.props.activeCommentTargetId}
        commentDraft={input.props.commentDraft}
        leftComments={
          deletionLineNumber === null
            ? []
            : getWorkspaceReviewDiffLineComments(
                input.props.commentsByLineKey,
                input.props.previousFilePath,
                deletionLineNumber,
              )
        }
        leftCommentTarget={
          deletionLineNumber === null
            ? null
            : createWorkspaceReviewDiffCommentTarget({
                anchor: "left",
                code: stripWorkspaceReviewDiffLineEnding(
                  input.props.fileDiff.deletionLines[deletionIndex] ?? "",
                ),
                lineNumber: deletionLineNumber,
                relativePath: input.props.previousFilePath,
                side: "deletion",
              })
        }
        leftHtml={hasDeletion ? input.props.highlightedLines.deletions[deletionIndex] : undefined}
        leftKind={hasDeletion ? "deletion" : "empty"}
        leftLineNumber={deletionLineNumber}
        onCancelComment={input.props.onCancelComment}
        onCommentDraftChange={input.props.onCommentDraftChange}
        onOpenComment={input.props.onOpenComment}
        onSubmitComment={input.props.onSubmitComment}
        rightComments={
          additionLineNumber === null
            ? []
            : getWorkspaceReviewDiffLineComments(
                input.props.commentsByLineKey,
                input.props.filePath,
                additionLineNumber,
              )
        }
        rightCommentTarget={
          additionLineNumber === null
            ? null
            : createWorkspaceReviewDiffCommentTarget({
                anchor: "right",
                code: stripWorkspaceReviewDiffLineEnding(
                  input.props.fileDiff.additionLines[additionIndex] ?? "",
                ),
                lineNumber: additionLineNumber,
                relativePath: input.props.filePath,
                side: "addition",
              })
        }
        rightHtml={hasAddition ? input.props.highlightedLines.additions[additionIndex] : undefined}
        rightKind={hasAddition ? "addition" : "empty"}
        rightLineNumber={additionLineNumber}
        wordWrap={input.props.wordWrap}
      />
    );
  });
}

function WorkspaceReviewDiffHunkSeparator(props: {
  readonly hunk: Hunk;
  readonly split?: boolean;
}) {
  if (props.hunk.collapsedBefore <= 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "grid min-h-7 items-center border-y border-border/40 bg-muted/12 text-[11px] text-muted-foreground/72",
        props.split
          ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          : "grid-cols-[3.75rem_minmax(0,1fr)]",
      )}
    >
      {props.split ? (
        <>
          <div className="px-3">{props.hunk.collapsedBefore} unchanged lines</div>
          <div className="border-l border-border/45 px-3">
            {props.hunk.collapsedBefore} unchanged lines
          </div>
        </>
      ) : (
        <>
          <div />
          <div>{props.hunk.collapsedBefore} unchanged lines</div>
        </>
      )}
    </div>
  );
}

function WorkspaceReviewDiffLine(props: WorkspaceReviewDiffLineProps) {
  const commentOpen = props.commentTarget?.id === props.activeCommentTargetId;
  return (
    <Fragment>
      <div
        className={cn(
          "group/review-line relative grid min-h-[1.65em] grid-cols-[3.75rem_minmax(0,1fr)]",
          commentOpen && "outline outline-1 -outline-offset-1 outline-foreground/18",
          getWorkspaceReviewDiffLineClasses(props.kind),
        )}
      >
        <div
          className={cn(
            "select-none border-r border-border/42 pr-3 text-right text-muted-foreground/58",
            props.kind === "addition" && "border-r-success/24 text-success",
            props.kind === "deletion" && "border-r-destructive/24 text-destructive",
          )}
        >
          {props.lineNumber ?? ""}
        </div>
        <WorkspaceReviewDiffCode html={props.html} kind={props.kind} wordWrap={props.wordWrap} />
        <WorkspaceReviewDiffCommentButton
          commentTarget={props.commentTarget}
          onOpenComment={props.onOpenComment}
        />
        {props.commentTarget && commentOpen ? (
          <WorkspaceReviewDiffCommentPopover
            commentDraft={props.commentDraft}
            commentTarget={props.commentTarget}
            onCancelComment={props.onCancelComment}
            onCommentDraftChange={props.onCommentDraftChange}
            onSubmitComment={props.onSubmitComment}
          />
        ) : null}
      </div>
      {props.comments.length > 0 ? (
        <WorkspaceReviewDiffInlineComments comments={props.comments} split={false} />
      ) : null}
    </Fragment>
  );
}

function WorkspaceReviewDiffSplitLine(props: WorkspaceReviewDiffSplitLineProps) {
  const leftCommentOpen = props.leftCommentTarget?.id === props.activeCommentTargetId;
  const rightCommentOpen = props.rightCommentTarget?.id === props.activeCommentTargetId;
  return (
    <Fragment>
      <div className="grid min-h-[1.65em] grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div
          className={cn(
            "group/review-line relative grid grid-cols-[3.75rem_minmax(0,1fr)] border-r border-border/48",
            leftCommentOpen && "outline outline-1 -outline-offset-1 outline-foreground/18",
            getWorkspaceReviewDiffLineClasses(props.leftKind),
          )}
        >
          <div
            className={cn(
              "select-none border-r border-border/42 pr-3 text-right text-muted-foreground/58",
              props.leftKind === "deletion" && "border-r-destructive/24 text-destructive",
            )}
          >
            {props.leftLineNumber ?? ""}
          </div>
          <WorkspaceReviewDiffCode
            html={props.leftHtml}
            kind={props.leftKind}
            wordWrap={props.wordWrap}
          />
          <WorkspaceReviewDiffCommentButton
            commentTarget={props.leftCommentTarget}
            onOpenComment={props.onOpenComment}
          />
          {props.leftCommentTarget && leftCommentOpen ? (
            <WorkspaceReviewDiffCommentPopover
              commentDraft={props.commentDraft}
              commentTarget={props.leftCommentTarget}
              onCancelComment={props.onCancelComment}
              onCommentDraftChange={props.onCommentDraftChange}
              onSubmitComment={props.onSubmitComment}
            />
          ) : null}
        </div>
        <div
          className={cn(
            "group/review-line relative grid grid-cols-[3.75rem_minmax(0,1fr)]",
            rightCommentOpen && "outline outline-1 -outline-offset-1 outline-foreground/18",
            getWorkspaceReviewDiffLineClasses(props.rightKind),
          )}
        >
          <div
            className={cn(
              "select-none border-r border-border/42 pr-3 text-right text-muted-foreground/58",
              props.rightKind === "addition" && "border-r-success/24 text-success",
            )}
          >
            {props.rightLineNumber ?? ""}
          </div>
          <WorkspaceReviewDiffCode
            html={props.rightHtml}
            kind={props.rightKind}
            wordWrap={props.wordWrap}
          />
          <WorkspaceReviewDiffCommentButton
            commentTarget={props.rightCommentTarget}
            onOpenComment={props.onOpenComment}
          />
          {props.rightCommentTarget && rightCommentOpen ? (
            <WorkspaceReviewDiffCommentPopover
              commentDraft={props.commentDraft}
              commentTarget={props.rightCommentTarget}
              onCancelComment={props.onCancelComment}
              onCommentDraftChange={props.onCommentDraftChange}
              onSubmitComment={props.onSubmitComment}
            />
          ) : null}
        </div>
      </div>
      {props.leftComments.length > 0 || props.rightComments.length > 0 ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <WorkspaceReviewDiffInlineComments comments={props.leftComments} split />
          <WorkspaceReviewDiffInlineComments comments={props.rightComments} split />
        </div>
      ) : null}
    </Fragment>
  );
}

function WorkspaceReviewDiffCommentButton(props: {
  readonly commentTarget: WorkspaceReviewDiffCommentTarget | null;
  readonly onOpenComment: (
    target: WorkspaceReviewDiffCommentTarget,
    anchorElement: HTMLElement,
  ) => void;
}) {
  if (!props.commentTarget) {
    return <div />;
  }

  return (
    <button
      type="button"
      className={cn(
        APP_FLOATING_CHIP_CLASS_NAME,
        "absolute top-1/2 left-1 z-10 flex size-5 -translate-y-1/2 text-muted-foreground/0 opacity-0 transition-[opacity,color,background-color,border-color] hover:border-foreground/18 hover:bg-foreground hover:text-background group-hover/review-line:text-muted-foreground/72 group-hover/review-line:opacity-100 focus-visible:text-muted-foreground/72 focus-visible:opacity-100",
      )}
      aria-label="Add diff comment"
      onClick={(event) => {
        event.stopPropagation();
        if (props.commentTarget) {
          props.onOpenComment(props.commentTarget, event.currentTarget);
        }
      }}
    >
      <PlusIcon className="size-3.5" />
    </button>
  );
}

function WorkspaceReviewDiffCommentPopover(props: {
  readonly commentDraft: string;
  readonly commentTarget: WorkspaceReviewDiffCommentTarget;
  readonly onCancelComment: () => void;
  readonly onCommentDraftChange: (draft: string) => void;
  readonly onSubmitComment: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const commentPlaceholder = useWorkspaceCommentPlaceholder("diff", props.commentTarget.id);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [props.commentTarget.id]);

  return (
    <form
      className={cn(
        APP_FLOATING_TOOLBAR_CLASS_NAME,
        "absolute top-1/2 left-12 z-30 flex h-11 w-[min(390px,calc(100vw-8rem))] -translate-y-1/2 items-center gap-2 rounded-full px-2",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmitComment();
      }}
    >
      <span
        className="glass-inset max-w-28 shrink-0 truncate rounded-full border border-border/50 px-2 py-1 font-mono text-[10px] leading-none text-muted-foreground/78"
        title={`${props.commentTarget.relativePath}:${props.commentTarget.lineNumber}`}
      >
        {props.commentTarget.side === "deletion" ? "old" : "new"} L{props.commentTarget.lineNumber}
      </span>
      <input
        ref={inputRef}
        autoFocus
        className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-[12.5px] font-medium text-foreground outline-none placeholder:text-muted-foreground/55"
        placeholder={commentPlaceholder}
        value={props.commentDraft}
        onChange={(event) => props.onCommentDraftChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancelComment();
          }
        }}
      />
      <button
        type="button"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground/62 hover:bg-foreground/[0.05] hover:text-foreground"
        aria-label="Cancel comment"
        onClick={props.onCancelComment}
      >
        <XIcon className="size-3.5" />
      </button>
      <button
        type="submit"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/88 disabled:pointer-events-none disabled:opacity-35"
        aria-label="Add comment"
        disabled={props.commentDraft.trim().length === 0}
      >
        <ArrowUpRightIcon className="size-3.5" />
      </button>
    </form>
  );
}

function WorkspaceReviewDiffInlineComments(props: {
  readonly comments: readonly WorkspaceCodeComment[];
  readonly split: boolean;
}) {
  if (props.comments.length === 0) {
    return props.split ? <div /> : null;
  }

  return (
    <div
      className={cn(
        "border-y border-border/35 bg-muted/8",
        props.split ? "border-r border-border/35 pl-[3.75rem]" : "pl-[3.75rem]",
      )}
    >
      <div className="space-y-1 px-3 py-1.5">
        {props.comments.map((comment) => (
          <div
            key={comment.id}
            className={cn(
              APP_WORKSPACE_INSET_CLASS_NAME,
              "flex min-w-0 items-start gap-2 px-2 py-1.5",
            )}
          >
            <MessageSquarePlusIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/62" />
            <p className="min-w-0 flex-1 whitespace-pre-wrap font-sans text-[11px] leading-4 text-foreground/80">
              {comment.body}
            </p>
            {comment.status === "queued" ? (
              <span className="shrink-0 rounded border border-border/45 px-1 py-px font-sans text-[8.5px] font-medium text-muted-foreground/58 uppercase">
                queued
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkspaceReviewDiffCode(props: {
  readonly html: string | undefined;
  readonly kind: WorkspaceReviewDiffLineProps["kind"];
  readonly wordWrap: boolean;
}) {
  const children = renderTrustedHighlightedHtml(props.html ?? "&nbsp;");
  return (
    <code
      className={cn(
        "block px-3 text-foreground",
        props.wordWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        props.kind === "empty" && "text-muted-foreground/35",
      )}
    >
      {children}
    </code>
  );
}

function getWorkspaceReviewDiffLineClasses(kind: WorkspaceReviewDiffLineProps["kind"]): string {
  switch (kind) {
    case "addition":
      return "bg-success/7";
    case "deletion":
      return "bg-destructive/7";
    case "empty":
      return "bg-muted/10";
    case "context":
      return "bg-transparent";
  }
}

function getAdditionLineNumber(hunk: Hunk, additionIndex: number): number {
  return hunk.additionStart + additionIndex - hunk.additionLineIndex;
}

function getDeletionLineNumber(hunk: Hunk, deletionIndex: number): number {
  return hunk.deletionStart + deletionIndex - hunk.deletionLineIndex;
}

function stripWorkspaceReviewDiffLineEnding(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function createWorkspaceReviewDiffLineCommentKey(relativePath: string, lineNumber: number): string {
  return `${relativePath}:${lineNumber}`;
}

function getWorkspaceReviewDiffLineComments(
  commentsByLineKey: ReadonlyMap<string, readonly WorkspaceCodeComment[]>,
  relativePath: string,
  lineNumber: number,
): readonly WorkspaceCodeComment[] {
  return (
    commentsByLineKey.get(createWorkspaceReviewDiffLineCommentKey(relativePath, lineNumber)) ?? []
  );
}

function createWorkspaceReviewDiffCommentTarget(input: {
  readonly anchor: WorkspaceReviewCommentAnchor;
  readonly code: string;
  readonly lineNumber: number;
  readonly relativePath: string;
  readonly side: "addition" | "deletion";
}): WorkspaceReviewDiffCommentTarget {
  return {
    anchor: input.anchor,
    code: input.code,
    id: `${input.side}:${input.relativePath}:${input.lineNumber}`,
    lineNumber: input.lineNumber,
    relativePath: input.relativePath,
    side: input.side,
  };
}

export default memo(WorkspaceReviewDiff);
