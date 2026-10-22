import { useMemo, useState, type ReactNode } from "react";
import type { ForgeFile } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";
import type { LineRange, LineTarget } from "@/features/panels/index.ts";
import { lineKeyOf, placeComments, type LineKey } from "./pr-code-comments.ts";
import type { PrDiffContext } from "./pr-extensions.ts";
import { PrLineComposer, PrPendingComment } from "./pr-line-composer.tsx";
import { usePrReview } from "./pr-review-context.tsx";
import { PrThread } from "./pr-thread.tsx";
import { useAskFocus, usePick } from "./pr-ui-store.tsx";

/** What the shared diff block needs to show and start comments on one file's lines. */
export interface FileComments {
  highlighted(target: LineTarget): boolean;
  selection: LineRange | undefined;
  onComment: ((range: LineRange) => void) | undefined;
  onExtend: ((range: LineRange) => void) | undefined;
  renderAnnotation(target: LineTarget): ReactNode;
}

const keyOf = (target: LineTarget): LineKey => `${target.side}:${target.line}`;
const none: readonly never[] = [];

/**
 * `list`, or the list returned last time when it holds the same items in the same order, so a
 * poll that changed nothing about this file recomputes nothing.
 */
function useSameList<T>(list: readonly T[]): readonly T[] {
  const [kept, setKept] = useState(list);
  if (kept === list) return kept;
  if (kept.length === list.length && list.every((item, at) => item === kept[at])) return kept;
  setKept(list);
  return list;
}

/** The composer's box id for focus: one per file. */
export const lineComposerFocus = (path: string) => `line:${path}`;

/**
 * A file's conversations on the diff: each review thread and pending review comment under its
 * last line (marking the lines it covers), and the comment being written under the lines
 * picked. New comments go only on the PR's current head, with All commits shown. What is being
 * written lives above the rows (`pr-ui-store`), so long files that mount only the rows on
 * screen keep it while it scrolls away.
 */
export function PrFileReview(props: {
  file: ForgeFile;
  diff: FileDiff;
  context: PrDiffContext;
  children(comments: FileComments): ReactNode;
}) {
  const review = usePrReview();
  const path = props.file.path;
  const [writing, setWriting] = usePick(path);
  const askFocus = useAskFocus();
  const range = props.context.files;
  const { diff } = props;
  const current = !range.commit && review?.state?.headSha === range.headSha;
  const allThreads = props.context.detail.status.reviewThreads;
  const threads = useSameList(
    useMemo(
      () => (range.commit ? none : allThreads.filter((thread) => thread.file === path)),
      [range.commit, allThreads, path],
    ),
  );
  const allDrafts = review?.state?.drafts;
  const drafts = useSameList(
    useMemo(
      () =>
        current
          ? (allDrafts ?? none).filter(
              (draft) => draft.anchor.path === path && draft.anchor.commit === range.headSha,
            )
          : none,
      [current, allDrafts, path, range.headSha],
    ),
  );
  const placed = useMemo(() => placeComments(diff, threads, drafts), [diff, threads, drafts]);
  const canComment =
    current && !!review?.state?.canComment && review.ready && !props.context.disabled;
  const writingKey = writing && lineKeyOf(diff, writing.side, writing.end);
  const pick = (picked: LineRange) => {
    setWriting(picked);
    askFocus(lineComposerFocus(path));
  };
  return props.children({
    highlighted: (target) =>
      placed.covered.has(keyOf(target)) ||
      (!!writing &&
        writing.side === target.side &&
        target.line >= writing.start &&
        target.line <= writing.end),
    selection: writing,
    onComment: canComment ? pick : undefined,
    onExtend: canComment ? pick : undefined,
    renderAnnotation: (target) => {
      const key = keyOf(target);
      const here = placed.threads.get(key) ?? none;
      const pending = placed.drafts.get(key) ?? none;
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
              path={path}
              patch={props.file.patch ?? null}
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
