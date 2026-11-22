import { useThreadField } from "@ace/client-react/thread-field";
import {
  groupFileChanges,
  exactPatchHunks,
  hunksFromChanges,
  linesOf,
  locateHunk,
  mapHunk,
  providerDisplayName,
  revertChange,
  turnHunks,
  type ChangeHunk,
  type FileDiff,
  type TurnHunk,
  type WholeLineChange,
} from "@ace/ui-core";
import { workspaceRelative } from "@ace/ui-core/file-references";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
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
import type { FileChange } from "@ace/protocol";
import { providerOf } from "./agent-changes.ts";
import { sharedDiff } from "./gutter-store.ts";
import { ReviewPeek } from "./hunk-peek.tsx";
import type { LiveGutter } from "./live-gutter.ts";

/*
 * Reviewing an agent's turn inside the editor (docs/editor/workbench.md 43–45): the turn's hunks
 * of this file, from the same diff Changes shows, found in the file as it is now and marked in
 * the gutter. The current one opens under its lines with Keep, Revert and Comment; F7 and ⇧F7
 * (or the peek's arrows) step through them, then on to the turn's next file.
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
  // The turn's hunks, exact to the byte where the turn says enough: from its before and after
  // text (diffed by the editor core), or its one patch. Otherwise they can be read but not
  // reverted (the diff rows carry no line endings).
  const texts = useMemo(() => turnTexts(own[0]?.changes ?? []), [own]);
  const patch = useMemo(() => singlePatch(own[0]?.changes ?? []), [own]);
  const [exact, setExact] = useState<{ after: string; hunks: readonly TurnHunk[] }>();
  useEffect(() => {
    if (!texts) return;
    let live = true;
    void sharedDiff()
      .lineChanges(texts.after, texts.before)
      .then(
        (changes) => {
          const lines = linesOf(texts.after);
          const found = hunksFromChanges(changes, (line) => lines[line] ?? "", lines.length);
          if (live) setExact({ after: texts.after, hunks: found });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [texts]);
  const exactHunks = texts
    ? exact?.after === texts.after
      ? exact.hunks
      : undefined
    : patch !== undefined
      ? exactPatchHunks(patch)
      : undefined;
  const rowHunks = useMemo(() => (diff ? turnHunks(diff.rows) : []), [diff]);
  const hunks = texts ? (exactHunks ?? []) : (exactHunks ?? rowHunks);
  const exactKnown = exactHunks !== undefined;
  // The file as the turn left it, when the turn recorded its text: the hunks are then carried to
  // the text now by the exact changes between the two, never matched by their words.
  const turnText = texts?.after;

  // Found again whenever the text has moved (the gutter settles after each pause in typing).
  const subscribe = useCallback((changed: () => void) => gutter.subscribe(changed), [gutter]);
  const marks = useSyncExternalStore(subscribe, () => gutter.state());
  const [mapping, setMapping] = useState<Mapping>();
  useEffect(() => {
    const doc = buffer.document();
    if (turnText === undefined || !doc) return;
    let live = true;
    const version = doc.version();
    void sharedDiff()
      .lineChanges(turnText, doc.text())
      .then(
        (changes) => {
          if (live && buffer.document() === doc && doc.version() === version)
            setMapping({ doc, version, changes });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the gutter's state moves with the text: map again after each pause.
  }, [turnText, buffer, marks]);
  /** Where each hunk is now, and whether its origin is proven (so Revert may act on it). */
  const find = (
    hunk: TurnHunk,
    fresh: boolean,
  ): { at: ChangeHunk; proven: boolean } | undefined => {
    const doc = buffer.document();
    if (!doc) return undefined;
    if (turnText !== undefined) {
      if (!mapping || mapping.doc !== doc) return undefined;
      const at = mapHunk(hunk, mapping.changes);
      return at && { at, proven: !fresh || mapping.version === doc.version() };
    }
    const at = locateHunk(hunk, (line) => doc.line(line), doc.lenLines());
    return at && { at, proven: !at.moved };
  };
  const located = hunks.map((hunk) => find(hunk, false)?.at);

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
  const finish = (lines: ChangeHunk) => {
    const finished = new Set(done).add(index);
    gutter.keep(lines.start - 1, lines.start - 1 + Math.max(1, lines.added.length));
    step(1, finished);
  };
  const keep = () => current && finish(current);
  // Revert acts only on a hunk whose origin is proven for the text as it is at the press (carried
  // by the exact changes since the turn, or found unmoved), and lands unsaved for the person's
  // own Save; gone, edited, moved or duplicated lines revert nothing.
  const turnHunk = hunks[index];
  const provenNow = turnHunk && find(turnHunk, true);
  const canRevert = exactKnown && provenNow?.proven === true;
  const revert = () => {
    const doc = buffer.document();
    const found = turnHunk && find(turnHunk, true);
    if (!doc || !exactKnown || !found?.proven) return;
    const now = found.at;
    const change = revertChange(now, (line) => doc.line(line), doc.lenLines(), doc.lineEnding());
    if (!change || !buffer.editLines([change], { manualSave: true })) return;
    gutter.edited();
    finish(now);
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
  }${current && !canRevert ? " · moved since the turn" : ""}`;
  const peek =
    current && !done.has(index)
      ? {
          after: Math.max(...current.marks) - 1,
          content: (
            <ReviewPeek
              hunk={current}
              where={where}
              onKeep={keep}
              onRevert={canRevert ? revert : undefined}
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

/** The changes from the turn's text of the file to the text now, for one document version. */
interface Mapping {
  doc: object;
  version: number;
  changes: readonly WholeLineChange[];
}

/**
 * The file's text before and after the turn, when every change of it recorded its whole text in
 * order.
 */
function turnTexts(changes: readonly FileChange[]): { before: string; after: string } | undefined {
  const first = changes[0];
  if (!first) return undefined;
  let text: string | undefined;
  for (const change of changes) {
    if (change.kind === "delete" || change.newText === undefined) return undefined;
    if (text !== undefined && change.oldText !== text) return undefined;
    text = change.newText;
  }
  return text === undefined ? undefined : { before: first.oldText ?? "", after: text };
}

/** The turn's one patch of the file, when that is all it recorded. */
function singlePatch(changes: readonly FileChange[]): string | undefined {
  const [only, ...rest] = changes;
  return only && rest.length === 0 && only.newText === undefined
    ? (only.diff ?? undefined)
    : undefined;
}

/** Where a file's review is: the change shown, and those kept or reverted. */
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
