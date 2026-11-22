import { useThreadField } from "@ace/client-react/thread-field";
import {
  groupFileChanges,
  keepAt,
  locateHunk,
  providerDisplayName,
  turnHunks,
  type ChangeHunk,
  type FileDiff,
} from "@ace/ui-core";
import { workspaceRelative } from "@ace/ui-core/file-references";
import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { AgentMark, EditorLayer } from "@/features/editor";
import type { TextBuffer } from "@/features/editor-workbench/index.ts";
import { useFileChanges } from "@/lib/diffs/use-file-diffs.ts";
import { useTurns } from "@/lib/diffs/use-turns.ts";
import { threadCheckoutRoot, threadProvider } from "@/lib/thread-fields.ts";
import {
  currentReview,
  endReview,
  requestReveal,
  useEditorReview,
  useOpenInEditorPanel,
} from "@/lib/workspace/index.ts";
import { providerOf } from "./agent-changes.ts";
import { ReviewPeek } from "./hunk-peek.tsx";
import type { LiveGutter } from "./live-gutter.ts";

/*
 * Reviewing an agent's turn inside the editor (docs/editor/workbench.md 43–45): the turn's hunks
 * of this file, from the same diff Changes shows, found in the file as it is now and marked in
 * the gutter. The current one opens under its lines with Keep and Comment; F7 and ⇧F7 (or the
 * peek's arrows) step through them, then on to the turn's next file. There is no Revert here: a
 * client can't prove a line is still the turn's (the person may have pasted a copy), so reverting
 * a turn is left to the daemon, which can apply the exact reverse patch to the exact disk version.
 */

export interface TurnReviewView {
  agentMarks: readonly AgentMark[];
  /** Shown side by side instead of inline: the turn's diff of the file, in place of the editor. */
  side: { diff: FileDiff; where: string; onInline(): void } | undefined;
  peek: { after: number; content: ReactNode } | undefined;
  /** No change of the turn can be shown in this file now: words, and Done to end the review. */
  idle: { words: string; onDone(): void } | undefined;
  onKey(event: KeyboardEvent): boolean;
}

const noFiles: never[] = [];

export function useTurnReview(input: {
  threadId: string;
  path: string;
  group: string;
  buffer: TextBuffer;
  gutter: LiveGutter;
  layer: EditorLayer | undefined;
}): TurnReviewView | undefined {
  const { threadId, path, group, buffer, gutter, layer } = input;
  const review = useEditorReview(threadId);
  const turns = useTurns(threadId);
  const checkout = useThreadField(threadId, threadCheckoutRoot);
  const provider = useThreadField(threadId, threadProvider);
  const agent = provider ? providerDisplayName(provider) : "The agent";
  const turn = review ? turns.find((each) => each.id === review.turn) : undefined;

  // The turn's files in the checkout's own paths, and this file's changes among them.
  const files = useMemo(
    () =>
      turn
        ? groupFileChanges(turn.edits).map((file) => ({
            path: workspaceRelative(file.path, checkout) ?? file.path,
            changes: file.changes,
          }))
        : noFiles,
    [turn, checkout],
  );
  // Every file's diff of the turn (the Changes diff worker caches them): this file's hunks, and
  // how many each file has, so the review ends only when every change of the turn is kept.
  const diffs = useFileChanges(files).files;
  const diff = diffs.find((each) => each.path === path);
  const hunks = useMemo(() => (diff ? turnHunks(diff.rows) : []), [diff]);
  const counts = useMemo(
    () => new Map(diffs.map((each) => [each.path, turnHunks(each.rows).length])),
    [diffs],
  );

  // Found again by their lines whenever the text has moved (the gutter settles after each pause
  // in typing). Only to show, step through and keep: nothing here changes the text.
  const subscribe = useCallback((changed: () => void) => gutter.subscribe(changed), [gutter]);
  // Placed again on each render, and at least once per settled change of the text (the gutter's
  // state moves): what the peek shows is where the change is as of that render.
  useSyncExternalStore(subscribe, () => gutter.state());
  const doc = buffer.document();
  const located = doc
    ? hunks.map((hunk) => locateHunk(hunk, (line) => doc.line(line), doc.lenLines()))
    : [];

  // Progress lives outside the view: a tab switch or a remount comes back to the same change.
  /** Where a file's progress in this review is kept. */
  const keyOf = (file: string) => (review ? `${threadId}\u0000${review.token}\u0000${file}` : "");
  const key = keyOf(path);
  const state = useSyncExternalStore(progress.subscribe, () => progress.get(key));
  const setState = (next: Omit<Progress, "side">) =>
    progress.set(key, { ...next, side: state?.side ?? false });
  const index = state?.index ?? 0;
  const done = state?.done ?? noneDone;

  const open = useOpenInEditorPanel(threadId);
  const reveal = (at: ChangeHunk) =>
    requestReveal(threadId, { path, group, line: at.start, focus: true });

  // A new review starts at the turn's first change in this file.
  const first = located.findIndex((hunk) => hunk !== undefined);
  const opening = first < 0 ? undefined : located[first];
  useEffect(() => {
    if (!key || !opening || progress.get(key)) return;
    progress.set(key, { index: first, done: noneDone, side: false });
    requestReveal(threadId, { path, group, line: opening.start, focus: true });
  }, [key, opening, first, path, group, threadId]);

  if (!review || !turn || !diff || hunks.length === 0) return undefined;
  const sideBySide = (side: boolean) => progress.set(key, { index, done, side });

  const current = located[index];
  const step = (direction: 1 | -1, finished: ReadonlySet<number> = done) => {
    for (let offset = 1; offset <= hunks.length; offset++) {
      const next = index + direction * offset;
      if (next < 0 || next >= hunks.length) break;
      const at = located[next];
      if (!at || finished.has(next)) continue;
      setState({ index: next, done: finished });
      return reveal(at);
    }
    // Past this file's last change: this file's progress is kept first (so coming back finds
    // it), then on to the next file of the turn, in this direction and wrapping round, that still
    // has a change to keep, opened at its first one.
    setState({ index, done: finished });
    const paths = files.map((file) => file.path);
    const here = paths.indexOf(path);
    for (let offset = 1; offset < paths.length; offset++) {
      const other =
        paths[(((here + direction * offset) % paths.length) + paths.length) % paths.length];
      if (other === undefined) continue;
      const otherKey = keyOf(other);
      const kept = progress.get(otherKey)?.done ?? noneDone;
      const total = counts.get(other) ?? 0;
      const next = Array.from({ length: total }, (_, at) => at).find((at) => !kept.has(at));
      if (next === undefined) continue;
      if (progress.get(otherKey)) progress.set(otherKey, { index: next, done: kept, side: false });
      return open(other, { keep: true, focus: true });
    }
    // No other file has one: back to the first change still to keep here.
    const wrap = located.findIndex((hunk, at) => hunk !== undefined && !finished.has(at));
    const at = located[wrap];
    setState({ index: Math.max(0, wrap), done: finished });
    if (at) return reveal(at);
    // Every change of the turn, in every file, is kept: the review is over.
    if (finished.size >= hunks.length) endReview(threadId);
  };
  // Keep acts on the change where it is at the press: found again in the text now, it must be
  // where the peek shows it. If the text moved and the review hasn't looked again yet, nothing is
  // kept and the review stays put (it shows the change in its new place after the pause).
  /** The change where it is at the press, if it is where the peek shows it; else undefined. */
  const atPress = (): ChangeHunk | undefined => {
    const text = buffer.document();
    const turnHunk = hunks[index];
    if (!text || !turnHunk || !current) return undefined;
    return keepAt(turnHunk, current, (line) => text.line(line), text.lenLines());
  };
  // Recorded, and the review moves on, only once the gutter has accepted the Keep: work the text
  // moved under before it ran is refused, and then nothing is recorded.
  const keep = () => {
    const now = atPress();
    if (!now) return gutter.edited();
    // A Keep belongs to the review it was made in: if another review started meanwhile, its
    // completion changes nothing.
    const made = review.token;
    void gutter.keep(now.start - 1, now.start - 1 + Math.max(1, now.added.length)).then((kept) => {
      if (!kept || currentReview(threadId)?.token !== made) return;
      step(1, new Set(progress.get(key)?.done ?? done).add(index));
    });
  };
  // Comment attaches to the change where it is at the press, checked as Keep is.
  const comment =
    layer?.annotate &&
    (() => {
      const now = atPress();
      if (!now) return gutter.edited();
      layer.annotate?.(now.start - 1, now.start - 2 + Math.max(1, now.added.length));
    });

  const label = `${agent} changed this in turn ${turn.number}`;
  const agentMarks: AgentMark[] = [];
  for (const [at, hunk] of located.entries())
    if (hunk && !done.has(at))
      agentMarks.push({
        start: hunk.start - 1,
        end: hunk.start - 1 + hunk.added.length,
        label,
        provider: providerOf(agent),
      });

  const lost = located.filter((hunk) => hunk === undefined).length;
  const where = `${agent} · turn ${turn.number} · ${index + 1} of ${hunks.length}${
    lost ? ` · ${lost} changed since` : ""
  }`;
  const peek =
    current && !done.has(index)
      ? {
          after: Math.max(...current.marks) - 1,
          content: (
            <ReviewPeek
              hunk={current}
              where={where}
              onKeep={keep}
              onComment={comment || undefined}
              onStep={(direction) => step(direction)}
              onSideBySide={() => sideBySide(true)}
              onDone={() => endReview(threadId)}
            />
          ),
        }
      : undefined;
  // Nothing of the turn can be shown here (all kept, or the rest edited away): say so, offer
  // Done, and leave F7 to the gutter.
  const showable = located.some((hunk, at) => hunk !== undefined && !done.has(at));
  const idle =
    peek || showable
      ? undefined
      : {
          words: `No change of turn ${turn.number} to show here.`,
          onDone: () => endReview(threadId),
        };
  return {
    agentMarks,
    side: state?.side ? { diff, where, onInline: () => sideBySide(false) } : undefined,
    peek,
    idle,
    onKey: (event) => {
      if (idle || event.key !== "F7" || event.altKey || event.metaKey || event.ctrlKey)
        return false;
      step(event.shiftKey ? -1 : 1);
      return true;
    },
  };
}

const noneDone: ReadonlySet<number> = new Set();

/** Where a file's review is: the change shown, and those kept. */
interface Progress {
  index: number;
  done: ReadonlySet<number>;
  /** The turn's diff shows side by side in place of the editor. */
  side: boolean;
}

/** Every file's review progress, by thread, review and path. */
const progress = (() => {
  const all = new Map<string, Progress>();
  const listeners = new Set<() => void>();
  return {
    get: (key: string) => all.get(key),
    set(key: string, next: Progress) {
      all.set(key, next);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
