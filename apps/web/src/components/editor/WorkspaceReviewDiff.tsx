import type { ChangeContent, ContextContent, FileDiffMetadata, Hunk } from "@pierre/diffs";
import { ArrowUpRightIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import { Fragment, memo, useEffect, useMemo, useState } from "react";

import {
  createPlainWorkspaceShikiHtmlLines,
  highlightWorkspaceShikiHtmlLines,
} from "~/lib/editor/workspaceShikiHighlight";
import {
  createWorkspaceCodeComment,
  type WorkspaceCodeComment,
} from "~/lib/editor/workspaceDesigner";
import { cn } from "~/lib/utils";

type WorkspaceReviewDiffRenderMode = "stacked" | "split";

interface WorkspaceReviewDiffProps {
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
  readonly commentDraft: string;
  readonly commentTarget: WorkspaceReviewDiffCommentTarget | null;
  readonly html: string | undefined;
  readonly kind: "addition" | "context" | "deletion" | "empty";
  readonly lineNumber: number | null;
  readonly onCancelComment: () => void;
  readonly onCommentDraftChange: (draft: string) => void;
  readonly onOpenComment: (target: WorkspaceReviewDiffCommentTarget) => void;
  readonly onSubmitComment: () => void;
  readonly wordWrap: boolean;
}

interface WorkspaceReviewDiffSplitLineProps {
  readonly activeCommentTargetId: string | null;
  readonly commentDraft: string;
  readonly leftCommentTarget: WorkspaceReviewDiffCommentTarget | null;
  readonly leftHtml: string | undefined;
  readonly leftKind: WorkspaceReviewDiffLineProps["kind"];
  readonly leftLineNumber: number | null;
  readonly onCancelComment: () => void;
  readonly onCommentDraftChange: (draft: string) => void;
  readonly onOpenComment: (target: WorkspaceReviewDiffCommentTarget) => void;
  readonly onSubmitComment: () => void;
  readonly rightCommentTarget: WorkspaceReviewDiffCommentTarget | null;
  readonly rightHtml: string | undefined;
  readonly rightKind: WorkspaceReviewDiffLineProps["kind"];
  readonly rightLineNumber: number | null;
  readonly wordWrap: boolean;
}

interface WorkspaceReviewDiffCommentTarget {
  readonly code: string;
  readonly id: string;
  readonly lineNumber: number;
  readonly relativePath: string;
}

interface WorkspaceReviewDiffRenderProps {
  readonly activeCommentTargetId: string | null;
  readonly commentDraft: string;
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly highlightedLines: WorkspaceReviewDiffHighlights;
  readonly onCancelComment: () => void;
  readonly onCommentDraftChange: (draft: string) => void;
  readonly onOpenComment: (target: WorkspaceReviewDiffCommentTarget) => void;
  readonly onSubmitComment: () => void;
  readonly previousFilePath: string;
  readonly wordWrap: boolean;
}

function WorkspaceReviewDiff(props: WorkspaceReviewDiffProps) {
  const [highlightedLines, setHighlightedLines] = useState<WorkspaceReviewDiffHighlights>(() => ({
    additions: createPlainWorkspaceShikiHtmlLines(props.fileDiff.additionLines),
    deletions: createPlainWorkspaceShikiHtmlLines(props.fileDiff.deletionLines),
  }));
  const [commentTarget, setCommentTarget] = useState<WorkspaceReviewDiffCommentTarget | null>(null);
  const [commentDraft, setCommentDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    setHighlightedLines({
      additions: createPlainWorkspaceShikiHtmlLines(props.fileDiff.additionLines),
      deletions: createPlainWorkspaceShikiHtmlLines(props.fileDiff.deletionLines),
    });

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
        setHighlightedLines({ additions, deletions });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [props.fileDiff, props.filePath, props.resolvedTheme]);

  const renderKey = useMemo(
    () =>
      `${props.fileDiff.cacheKey ?? props.filePath}:${props.renderMode}:${
        props.wordWrap ? "wrap" : "scroll"
      }`,
    [props.fileDiff.cacheKey, props.filePath, props.renderMode, props.wordWrap],
  );
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
    setCommentDraft("");
    setCommentTarget(null);
  };
  const cancelComment = () => {
    setCommentDraft("");
    setCommentTarget(null);
  };

  return (
    <div
      key={renderKey}
      className={cn(
        "h-full min-h-0 overflow-auto bg-background font-mono text-[12.5px] leading-[1.65]",
        props.wordWrap ? "overflow-x-hidden" : "overflow-x-auto",
      )}
    >
      <div className={cn("min-w-full py-1", props.wordWrap ? "w-full" : "w-max")}>
        {props.renderMode === "split" ? (
          <WorkspaceReviewSplitDiff
            activeCommentTargetId={commentTarget?.id ?? null}
            commentDraft={commentDraft}
            fileDiff={props.fileDiff}
            filePath={props.filePath}
            highlightedLines={highlightedLines}
            onCancelComment={cancelComment}
            onCommentDraftChange={setCommentDraft}
            onOpenComment={setCommentTarget}
            onSubmitComment={submitComment}
            previousFilePath={props.fileDiff.prevName ?? props.filePath}
            wordWrap={props.wordWrap}
          />
        ) : (
          <WorkspaceReviewUnifiedDiff
            activeCommentTargetId={commentTarget?.id ?? null}
            commentDraft={commentDraft}
            fileDiff={props.fileDiff}
            filePath={props.filePath}
            highlightedLines={highlightedLines}
            onCancelComment={cancelComment}
            onCommentDraftChange={setCommentDraft}
            onOpenComment={setCommentTarget}
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
        commentTarget={createWorkspaceReviewDiffCommentTarget({
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
        commentTarget={createWorkspaceReviewDiffCommentTarget({
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
        commentTarget={createWorkspaceReviewDiffCommentTarget({
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
        leftCommentTarget={createWorkspaceReviewDiffCommentTarget({
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
        rightCommentTarget={createWorkspaceReviewDiffCommentTarget({
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
        leftCommentTarget={
          deletionLineNumber === null
            ? null
            : createWorkspaceReviewDiffCommentTarget({
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
        rightCommentTarget={
          additionLineNumber === null
            ? null
            : createWorkspaceReviewDiffCommentTarget({
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
        "grid min-h-7 items-center border-y border-border/55 bg-muted/18 text-[11px] text-muted-foreground/72",
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
          "group/review-line grid min-h-[1.65em] grid-cols-[3.75rem_minmax(0,1fr)_2rem]",
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
      </div>
      {props.commentTarget && commentOpen ? (
        <WorkspaceReviewDiffCommentForm
          commentDraft={props.commentDraft}
          commentTarget={props.commentTarget}
          onCancelComment={props.onCancelComment}
          onCommentDraftChange={props.onCommentDraftChange}
          onSubmitComment={props.onSubmitComment}
        />
      ) : null}
    </Fragment>
  );
}

function WorkspaceReviewDiffSplitLine(props: WorkspaceReviewDiffSplitLineProps) {
  const activeCommentTarget =
    props.leftCommentTarget?.id === props.activeCommentTargetId
      ? props.leftCommentTarget
      : props.rightCommentTarget?.id === props.activeCommentTargetId
        ? props.rightCommentTarget
        : null;
  return (
    <Fragment>
      <div className="grid min-h-[1.65em] grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div
          className={cn(
            "group/review-line grid grid-cols-[3.75rem_minmax(0,1fr)_2rem] border-r border-border/48",
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
        </div>
        <div
          className={cn(
            "group/review-line grid grid-cols-[3.75rem_minmax(0,1fr)_2rem]",
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
        </div>
      </div>
      {activeCommentTarget ? (
        <WorkspaceReviewDiffCommentForm
          commentDraft={props.commentDraft}
          commentTarget={activeCommentTarget}
          onCancelComment={props.onCancelComment}
          onCommentDraftChange={props.onCommentDraftChange}
          onSubmitComment={props.onSubmitComment}
          split
        />
      ) : null}
    </Fragment>
  );
}

function WorkspaceReviewDiffCommentButton(props: {
  readonly commentTarget: WorkspaceReviewDiffCommentTarget | null;
  readonly onOpenComment: (target: WorkspaceReviewDiffCommentTarget) => void;
}) {
  if (!props.commentTarget) {
    return <div />;
  }

  return (
    <button
      type="button"
      className="flex size-6 items-center justify-center self-center justify-self-center rounded-md text-muted-foreground/0 transition-colors hover:bg-muted/35 hover:text-foreground group-hover/review-line:text-muted-foreground/58"
      aria-label="Add diff comment"
      onClick={() => {
        if (props.commentTarget) {
          props.onOpenComment(props.commentTarget);
        }
      }}
    >
      <MessageSquarePlusIcon className="size-3.5" />
    </button>
  );
}

function WorkspaceReviewDiffCommentForm(props: {
  readonly commentDraft: string;
  readonly commentTarget: WorkspaceReviewDiffCommentTarget;
  readonly onCancelComment: () => void;
  readonly onCommentDraftChange: (draft: string) => void;
  readonly onSubmitComment: () => void;
  readonly split?: boolean;
}) {
  return (
    <form
      className={cn(
        "grid border-y border-border/55 bg-muted/10",
        props.split
          ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          : "grid-cols-[3.75rem_minmax(0,1fr)]",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmitComment();
      }}
    >
      <div className={props.split ? "hidden" : undefined} />
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 px-3 py-2",
          props.split && "col-span-2 pl-[3.75rem]",
        )}
      >
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/58">
          {props.commentTarget.relativePath}:{props.commentTarget.lineNumber}
        </span>
        <input
          autoFocus
          className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/45 focus:border-foreground/35"
          placeholder="Comment for the agent"
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
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/62 hover:bg-muted/35 hover:text-foreground"
          aria-label="Cancel comment"
          onClick={props.onCancelComment}
        >
          <XIcon className="size-3.5" />
        </button>
        <button
          type="submit"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-muted/35 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          aria-label="Add comment"
          disabled={props.commentDraft.trim().length === 0}
        >
          <ArrowUpRightIcon className="size-3.5" />
        </button>
      </div>
    </form>
  );
}

function WorkspaceReviewDiffCode(props: {
  readonly html: string | undefined;
  readonly kind: WorkspaceReviewDiffLineProps["kind"];
  readonly wordWrap: boolean;
}) {
  return (
    <code
      className={cn(
        "block px-3 text-foreground",
        props.wordWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        props.kind === "empty" && "text-muted-foreground/35",
      )}
      dangerouslySetInnerHTML={{ __html: props.html ?? "&nbsp;" }}
    />
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

function createWorkspaceReviewDiffCommentTarget(input: {
  readonly code: string;
  readonly lineNumber: number;
  readonly relativePath: string;
  readonly side: "addition" | "deletion";
}): WorkspaceReviewDiffCommentTarget {
  return {
    code: input.code,
    id: `${input.side}:${input.relativePath}:${input.lineNumber}`,
    lineNumber: input.lineNumber,
    relativePath: input.relativePath,
  };
}

export default memo(WorkspaceReviewDiff);
