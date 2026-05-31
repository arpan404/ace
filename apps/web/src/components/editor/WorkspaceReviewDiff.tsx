import type { ChangeContent, ContextContent, FileDiffMetadata, Hunk } from "@pierre/diffs";
import { memo, useEffect, useMemo, useState } from "react";

import {
  createPlainWorkspaceShikiHtmlLines,
  highlightWorkspaceShikiHtmlLines,
} from "~/lib/editor/workspaceShikiHighlight";
import { cn } from "~/lib/utils";

type WorkspaceReviewDiffRenderMode = "stacked" | "split";

interface WorkspaceReviewDiffProps {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly renderMode: WorkspaceReviewDiffRenderMode;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
}

interface WorkspaceReviewDiffHighlights {
  readonly additions: readonly string[];
  readonly deletions: readonly string[];
}

interface WorkspaceReviewDiffLineProps {
  readonly html: string | undefined;
  readonly kind: "addition" | "context" | "deletion" | "empty";
  readonly lineNumber: number | null;
  readonly wordWrap: boolean;
}

interface WorkspaceReviewDiffSplitLineProps {
  readonly leftHtml: string | undefined;
  readonly leftKind: WorkspaceReviewDiffLineProps["kind"];
  readonly leftLineNumber: number | null;
  readonly rightHtml: string | undefined;
  readonly rightKind: WorkspaceReviewDiffLineProps["kind"];
  readonly rightLineNumber: number | null;
  readonly wordWrap: boolean;
}

function WorkspaceReviewDiff(props: WorkspaceReviewDiffProps) {
  const [highlightedLines, setHighlightedLines] = useState<WorkspaceReviewDiffHighlights>(() => ({
    additions: createPlainWorkspaceShikiHtmlLines(props.fileDiff.additionLines),
    deletions: createPlainWorkspaceShikiHtmlLines(props.fileDiff.deletionLines),
  }));

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
            fileDiff={props.fileDiff}
            highlightedLines={highlightedLines}
            wordWrap={props.wordWrap}
          />
        ) : (
          <WorkspaceReviewUnifiedDiff
            fileDiff={props.fileDiff}
            highlightedLines={highlightedLines}
            wordWrap={props.wordWrap}
          />
        )}
      </div>
    </div>
  );
}

function WorkspaceReviewUnifiedDiff(props: {
  readonly fileDiff: FileDiffMetadata;
  readonly highlightedLines: WorkspaceReviewDiffHighlights;
  readonly wordWrap: boolean;
}) {
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
                highlightedLines: props.highlightedLines,
                key: `${hunkIndex}:${contentIndex}:context`,
                wordWrap: props.wordWrap,
              });
            }

            return renderUnifiedChangeContent({
              content,
              hunk,
              highlightedLines: props.highlightedLines,
              key: `${hunkIndex}:${contentIndex}:change`,
              wordWrap: props.wordWrap,
            });
          })}
        </div>
      ))}
    </>
  );
}

function WorkspaceReviewSplitDiff(props: {
  readonly fileDiff: FileDiffMetadata;
  readonly highlightedLines: WorkspaceReviewDiffHighlights;
  readonly wordWrap: boolean;
}) {
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
                highlightedLines: props.highlightedLines,
                key: `${hunkIndex}:${contentIndex}:context`,
                wordWrap: props.wordWrap,
              });
            }

            return renderSplitChangeContent({
              content,
              hunk,
              highlightedLines: props.highlightedLines,
              key: `${hunkIndex}:${contentIndex}:change`,
              wordWrap: props.wordWrap,
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
  readonly highlightedLines: WorkspaceReviewDiffHighlights;
  readonly key: string;
  readonly wordWrap: boolean;
}) {
  return Array.from({ length: input.content.lines }, (_, index) => {
    const additionIndex = input.content.additionLineIndex + index;
    const lineNumber = getAdditionLineNumber(input.hunk, additionIndex);
    return (
      <WorkspaceReviewDiffLine
        key={`${input.key}:${index}`}
        html={input.highlightedLines.additions[additionIndex]}
        kind="context"
        lineNumber={lineNumber}
        wordWrap={input.wordWrap}
      />
    );
  });
}

function renderUnifiedChangeContent(input: {
  readonly content: ChangeContent;
  readonly hunk: Hunk;
  readonly highlightedLines: WorkspaceReviewDiffHighlights;
  readonly key: string;
  readonly wordWrap: boolean;
}) {
  const rows = [];
  for (let index = 0; index < input.content.deletions; index += 1) {
    const deletionIndex = input.content.deletionLineIndex + index;
    rows.push(
      <WorkspaceReviewDiffLine
        key={`${input.key}:deletion:${index}`}
        html={input.highlightedLines.deletions[deletionIndex]}
        kind="deletion"
        lineNumber={getDeletionLineNumber(input.hunk, deletionIndex)}
        wordWrap={input.wordWrap}
      />,
    );
  }
  for (let index = 0; index < input.content.additions; index += 1) {
    const additionIndex = input.content.additionLineIndex + index;
    rows.push(
      <WorkspaceReviewDiffLine
        key={`${input.key}:addition:${index}`}
        html={input.highlightedLines.additions[additionIndex]}
        kind="addition"
        lineNumber={getAdditionLineNumber(input.hunk, additionIndex)}
        wordWrap={input.wordWrap}
      />,
    );
  }
  return rows;
}

function renderSplitContextContent(input: {
  readonly content: ContextContent;
  readonly hunk: Hunk;
  readonly highlightedLines: WorkspaceReviewDiffHighlights;
  readonly key: string;
  readonly wordWrap: boolean;
}) {
  return Array.from({ length: input.content.lines }, (_, index) => {
    const deletionIndex = input.content.deletionLineIndex + index;
    const additionIndex = input.content.additionLineIndex + index;
    return (
      <WorkspaceReviewDiffSplitLine
        key={`${input.key}:${index}`}
        leftHtml={input.highlightedLines.deletions[deletionIndex]}
        leftKind="context"
        leftLineNumber={getDeletionLineNumber(input.hunk, deletionIndex)}
        rightHtml={input.highlightedLines.additions[additionIndex]}
        rightKind="context"
        rightLineNumber={getAdditionLineNumber(input.hunk, additionIndex)}
        wordWrap={input.wordWrap}
      />
    );
  });
}

function renderSplitChangeContent(input: {
  readonly content: ChangeContent;
  readonly hunk: Hunk;
  readonly highlightedLines: WorkspaceReviewDiffHighlights;
  readonly key: string;
  readonly wordWrap: boolean;
}) {
  const rowCount = Math.max(input.content.deletions, input.content.additions);
  return Array.from({ length: rowCount }, (_, index) => {
    const hasDeletion = index < input.content.deletions;
    const hasAddition = index < input.content.additions;
    const deletionIndex = input.content.deletionLineIndex + index;
    const additionIndex = input.content.additionLineIndex + index;
    return (
      <WorkspaceReviewDiffSplitLine
        key={`${input.key}:${index}`}
        leftHtml={hasDeletion ? input.highlightedLines.deletions[deletionIndex] : undefined}
        leftKind={hasDeletion ? "deletion" : "empty"}
        leftLineNumber={hasDeletion ? getDeletionLineNumber(input.hunk, deletionIndex) : null}
        rightHtml={hasAddition ? input.highlightedLines.additions[additionIndex] : undefined}
        rightKind={hasAddition ? "addition" : "empty"}
        rightLineNumber={hasAddition ? getAdditionLineNumber(input.hunk, additionIndex) : null}
        wordWrap={input.wordWrap}
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
  return (
    <div
      className={cn(
        "grid min-h-[1.65em] grid-cols-[3.75rem_minmax(0,1fr)]",
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
    </div>
  );
}

function WorkspaceReviewDiffSplitLine(props: WorkspaceReviewDiffSplitLineProps) {
  return (
    <div className="grid min-h-[1.65em] grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div
        className={cn(
          "grid grid-cols-[3.75rem_minmax(0,1fr)] border-r border-border/48",
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
      </div>
      <div
        className={cn(
          "grid grid-cols-[3.75rem_minmax(0,1fr)]",
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
      </div>
    </div>
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

export default memo(WorkspaceReviewDiff);
