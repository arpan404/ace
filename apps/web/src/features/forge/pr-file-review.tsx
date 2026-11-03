import { useMemo, useState, type ReactNode } from "react";
import type { ForgeFile, ForgePrStatus } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";
import type { LineRange, LineTarget } from "@/features/panels/index.ts";
import { placeComments, placePick, type LineKey } from "./pr-code-comments.ts";
import type { PrDiffContext } from "./pr-extensions.ts";
import { PrLineComposer, PrPendingComment } from "./pr-line-composer.tsx";
import { usePrReview } from "./pr-review-context.tsx";
import { PrThread } from "./pr-thread.tsx";
import { usePrPatchOf } from "./pr-file-pages.ts";
import { useAskFocus, usePick } from "./pr-ui-store.tsx";

/** What the shared diff block needs to show and start comments on one file's lines. */
export interface FileComments {
  highlighted(target: LineTarget): boolean;
  selection: LineRange | undefined;
  onComment: ((range: LineRange) => void) | undefined;
  onExtend: ((range: LineRange) => void) | undefined;
  renderAnnotation(target: LineTarget): ReactNode;
  /** Some conversation or comment sits under its lines. */
  annotated: boolean;
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
 * picked. New comments go only on the PR's current head: on All commits, or on a commit view
 * whose new side is the head's. What is being written lives above the rows (`pr-ui-store`), so
 * long files that mount only the rows on screen keep it while it scrolls away.
 */
export function PrFileReview(props: {
  file: ForgeFile;
  diff: FileDiff;
  context: PrDiffContext;
  /** The conversations the range draws on this file (`threadsAtHead`). */
  threads: readonly ForgePrStatus["reviewThreads"][number][];
  /** Split view draws each side's lines in its own column, so comments sit on their side. */
  mode: "unified" | "split";
  children(comments: FileComments): ReactNode;
}) {
  const review = usePrReview();
  const path = props.file.path;
  // In a commit view a comment still sits on GitHub's patch of All commits.
  const patchOf = usePrPatchOf(props.context.workspaceId, props.context.detail);
  const [picked, setPicked] = usePick(path);
  const askFocus = useAskFocus();
  const range = props.context.files;
  const { diff } = props;
  const head = props.context.detail.status.headSha;
  const current = range.headSha === head && review?.state?.headSha === head;
  // A pick from another head or commit view names other code now: it isn't shown here. Its text
  // stays in the file's draft for the next pick.
  const writing =
    current && picked?.headSha === range.headSha && picked.commit === (range.commit ?? "")
      ? picked.range
      : undefined;
  const threads = useSameList(props.threads);
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
    current &&
    // A locked conversation still opens the line composer, off, so it can say why.
    (!!review?.state?.canComment || !!review?.commentsLocked) &&
    review.ready &&
    !props.context.disabled;
  const split = props.mode === "split";
  const view = split ? placed.split : placed.unified;
  // Under the picked line's row (in split view, its own side's line). A line from an opened
  // fold has no row of the patch's, so the composer sits under the line itself and says GitHub
  // can't take a comment there.
  const writingAt = useMemo(
    () => (writing ? placePick(diff, writing, props.mode) : undefined),
    [diff, writing, props.mode],
  );
  const pick = (lines: LineRange) => {
    setPicked({ headSha: range.headSha, commit: range.commit ?? "", range: lines });
    askFocus(lineComposerFocus(path));
  };
  return props.children({
    annotated: threads.length > 0 || drafts.length > 0 || !!writing,
    highlighted: (target) =>
      placed.covered.has(keyOf(target)) || !!writingAt?.marked.has(keyOf(target)),
    selection: writing,
    onComment: canComment ? pick : undefined,
    onExtend: canComment ? pick : undefined,
    renderAnnotation: (target) => {
      const key = keyOf(target);
      const here = view.threads.get(key) ?? none;
      const pending = view.drafts.get(key) ?? none;
      const composing = writingAt?.end === key;
      if (!here.length && !pending.length && !composing) return null;
      return (
        <div className="sticky left-0 w-[100cqw] max-w-full min-w-0 space-y-4 border-y border-border bg-background px-4 py-3 font-sans text-ui whitespace-normal">
          {here.map((thread) => (
            <div key={thread.id} data-pr-thread={thread.id}>
              <PrThread thread={thread} />
            </div>
          ))}
          {pending.map((draft) => (
            <PrPendingComment key={draft.id} draft={draft} />
          ))}
          {composing && writing && (
            <PrLineComposer
              path={path}
              patch={range.commit ? patchOf(path) : (props.file.patch ?? null)}
              commitView={!!range.commit}
              diff={diff}
              range={writing}
              headSha={range.headSha}
              onClose={() => setPicked(undefined)}
            />
          )}
        </div>
      );
    },
  });
}
