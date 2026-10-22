import { useMemo, useState, type ReactNode } from "react";
import type { ForgeFile, ForgeReviewDraft, ForgePrStatus } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";
import type { LineRange, LineTarget } from "@/features/panels/index.ts";
import { lineKeyOf, placeThreads, type LineKey } from "./pr-code-model.ts";
import type { PrDiffContext } from "./pr-extensions.ts";
import { PrLineComposer, PrPendingComment } from "./pr-line-composer.tsx";
import { usePrReview } from "./pr-review-context.tsx";
import { PrThread } from "./pr-thread.tsx";

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/** What the shared diff block needs to show and start comments on one file's lines. */
export interface FileComments {
  highlighted(target: LineTarget): boolean;
  selection: LineRange | undefined;
  onComment: ((range: LineRange) => void) | undefined;
  onExtend: ((range: LineRange) => void) | undefined;
  renderAnnotation(target: LineTarget): ReactNode;
}

const keyOf = (target: LineTarget): LineKey => `${target.side}:${target.line}`;
const covers = (side: "old" | "new", start: number, end: number, target: LineTarget) =>
  target.side === side && target.line >= start && target.line <= end;

/**
 * A file's conversations on the diff: each review thread and pending review comment under its
 * last line (marking the lines it covers), and the comment being written under the lines
 * picked. New comments go only on the PR's current head, with All commits shown.
 */
export function PrFileReview(props: {
  file: ForgeFile;
  diff: FileDiff;
  context: PrDiffContext;
  children(comments: FileComments): ReactNode;
}) {
  const review = usePrReview();
  const [writing, setWriting] = useState<LineRange>();
  const range = props.context.files;
  const { diff } = props;
  const current = !range.commit && review?.state?.headSha === range.headSha;
  const threads = useMemo(
    () =>
      range.commit
        ? new Map<LineKey, ReviewThread[]>()
        : placeThreads(props.context.detail.status.reviewThreads, diff),
    [range.commit, props.context.detail.status.reviewThreads, diff],
  );
  const drafts = useMemo(() => {
    const placed = new Map<LineKey, ForgeReviewDraft[]>();
    if (!current) return placed;
    for (const draft of review?.state?.drafts ?? []) {
      const { anchor } = draft;
      if (anchor.path !== props.file.path || anchor.commit !== range.headSha) continue;
      const key = lineKeyOf(diff, anchor.side === "LEFT" ? "old" : "new", anchor.line);
      if (key) placed.set(key, [...(placed.get(key) ?? []), draft]);
    }
    return placed;
  }, [current, review?.state?.drafts, props.file.path, range.headSha, diff]);
  const canComment =
    current && !!review?.state?.canComment && review.ready && !props.context.disabled;
  const marked = (target: LineTarget) => {
    for (const list of threads.values())
      for (const thread of list) {
        if (thread.line === null) continue;
        const side = thread.side === "LEFT" ? "old" : "new";
        if (covers(side, thread.startLine ?? thread.line, thread.line, target)) return true;
      }
    for (const list of drafts.values())
      for (const { anchor } of list) {
        const side = anchor.side === "LEFT" ? "old" : "new";
        if (covers(side, anchor.startLine ?? anchor.line, anchor.line, target)) return true;
      }
    return false;
  };
  const writingKey = writing && lineKeyOf(diff, writing.side, writing.end);
  return props.children({
    highlighted: (target) =>
      (!!writing && covers(writing.side, writing.start, writing.end, target)) || marked(target),
    selection: writing,
    onComment: canComment ? setWriting : undefined,
    onExtend: canComment ? setWriting : undefined,
    renderAnnotation: (target) => {
      const key = keyOf(target);
      const here = threads.get(key) ?? [];
      const pending = drafts.get(key) ?? [];
      const composing = writing && writingKey === key;
      if (!here.length && !pending.length && !composing) return null;
      return (
        <div className="sticky left-0 w-[100cqw] max-w-full min-w-0 space-y-4 border-y border-border bg-background px-4 py-3 font-sans text-ui whitespace-normal">
          {here.map((thread) => (
            <PrThread key={thread.id} thread={thread} />
          ))}
          {pending.map((draft) => (
            <PrPendingComment key={draft.id} draft={draft} />
          ))}
          {composing && writing && (
            <PrLineComposer
              key={`${writing.side}:${writing.start}-${writing.end}`}
              path={props.file.path}
              diff={diff}
              range={writing}
              headSha={range.headSha}
              onClose={() => setWriting(undefined)}
            />
          )}
        </div>
      );
    },
  });
}
