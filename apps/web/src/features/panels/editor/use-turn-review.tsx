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
  const own = useMemo(() => files.filter((file) => file.path === path), [files, path]);
  const diff = useFileChanges(own).files[0];
  const hunks = useMemo(() => (diff ? turnHunks(diff.rows) : []), [diff]);

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
  const key = review ? `${threadId}\u0000${review.token}\u0000${path}` : "";
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
    // Past this file's last change: on to the turn's next file, else back to the first here.
    const paths = files.map((file) => file.path);
    const other = paths[paths.indexOf(path) + direction];
    if (other !== undefined) return open(other, { keep: true, focus: true });
    const wrap = located.findIndex((hunk, at) => hunk !== undefined && !finished.has(at));
    const at = located[wrap];
    setState({ index: Math.max(0, wrap), done: finished });
    if (at) reveal(at);
  };
  // Keep acts on the change where it is at the press: found again in the text now, it must be
  // where the peek shows it. If the text moved and the review hasn't looked again yet, nothing is
  // kept and the review stays put (it shows the change in its new place after the pause).
  const keep = () => {
    const doc = buffer.document();
    const turnHunk = hunks[index];
    if (!doc || !turnHunk || !current) return;
    const now = keepAt(turnHunk, current, (line) => doc.line(line), doc.lenLines());
    if (!now) return gutter.edited();
    gutter.keep(now.start - 1, now.start - 1 + Math.max(1, now.added.length));
    step(1, new Set(done).add(index));
  };
  const comment =
    layer?.annotate &&
    (() =>
      current &&
      layer.annotate?.(current.start - 1, current.start - 2 + Math.max(1, current.added.length)));

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
  return {
    agentMarks,
    side: state?.side ? { diff, where, onInline: () => sideBySide(false) } : undefined,
    peek,
    onKey: (event) => {
      if (event.key !== "F7" || event.altKey || event.metaKey || event.ctrlKey) return false;
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
