import { committedFromPatch, hunkAt, type ChangeHunk, type LineMark } from "@ace/ui-core";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { AgentMark } from "@/features/editor";
import type { TextBuffer } from "@/features/editor-workbench/index.ts";
import { requestReveal } from "@/lib/workspace/index.ts";
import { useChangeMarks } from "../files/use-change-marks.ts";
import { blockWords } from "./agent-lines.ts";
import { liveGutterFor } from "./gutter-store.ts";
import { HunkPeek } from "./hunk-peek.tsx";

/*
 * What one view of an open file draws in its gutter (docs/editor/workbench.md 43–44): the live
 * marks against the last commit, the lines agents wrote, and the change under a pressed mark
 * with Revert. F7 and ⇧F7 step through the changes, each opening under its lines.
 */

const noMarks: ReadonlyMap<number, LineMark> = new Map();

export interface ChangeGutterView {
  marks: ReadonlyMap<number, LineMark> | undefined;
  agentMarks: readonly AgentMark[];
  head: string | undefined;
  hunks: readonly ChangeHunk[];
  onMarkClick(line: number): void;
  peek: { after: number; content: ReactNode } | undefined;
  /** The view's text changed: the marks follow once typing pauses. */
  edited(): void;
  /** F7 / ⇧F7 inside the view; true when taken. */
  onKey(event: KeyboardEvent): boolean;
}

/** The hunk after (or before) the one at `line`, wrapping; the first one with none open. */
export function stepHunk(
  hunks: readonly ChangeHunk[],
  line: number | undefined,
  direction: 1 | -1,
): ChangeHunk | undefined {
  if (hunks.length === 0) return undefined;
  const at = line === undefined ? -1 : hunks.findIndex((hunk) => hunk.marks.includes(line));
  if (at < 0) {
    if (line === undefined) return direction === 1 ? hunks[0] : hunks.at(-1);
    const after = hunks.find((hunk) => hunk.start > line);
    const before = hunks.findLast((hunk) => hunk.start < line);
    return direction === 1 ? (after ?? hunks[0]) : (before ?? hunks.at(-1));
  }
  return hunks[(at + direction + hunks.length) % hunks.length];
}

export function useChangeGutter(input: {
  threadId: string;
  path: string;
  group: string;
  buffer: TextBuffer;
}): ChangeGutterView {
  const { threadId, path, group, buffer } = input;
  const gutter = liveGutterFor(buffer);
  const subscribe = useCallback((changed: () => void) => gutter.subscribe(changed), [gutter]);
  const state = useSyncExternalStore(subscribe, () => gutter.state());
  const onBuffer = useCallback((changed: () => void) => buffer.subscribe(changed), [buffer]);
  const version = useSyncExternalStore(onBuffer, () => buffer.snapshot().version);

  // The committed text: the file on disk with git's hunks put back. Hunks read for an older
  // version don't fit and are skipped, so a save or an agent's write keeps the last one.
  const { patch, settled, truncated, head: commit } = useChangeMarks(threadId, path, version);
  useEffect(() => {
    const base = buffer.baseText();
    // Only the read of git's diff for this commit and this disk version sets the committed text;
    // until it is in, the marks keep the last one and Revert waits (an older read's hunks would
    // undo newly committed work).
    if (base === undefined || version === undefined || !settled) return gutter.unsettle();
    // A diff the daemon cut at its size cap proves nothing about any file (a cut can fall between
    // hunks, or inside a line): no committed text is taken from it, and Revert stays off.
    if (truncated) return gutter.unsettle();
    // Rebuilt from git's own patch, byte for byte: line endings and final newlines as committed.
    // A patch with a hunk cut short gives nothing.
    const head = patch ? committedFromPatch(base, patch) : base;
    if (head === undefined) return gutter.unsettle();
    gutter.setHead(head, `${commit ?? ""}\u0000${version}`);
  }, [buffer, gutter, version, patch, settled, truncated, commit]);

  const agentMarks = useMemo(
    () =>
      state.agent.map((block) => ({
        start: block.start,
        end: block.end,
        label: blockWords(block.who),
        provider: block.who.provider,
      })),
    [state.agent],
  );

  const edited = useCallback(() => gutter.edited(), [gutter]);
  const [peekLine, setPeekLine] = useState<number>();
  const hunk = peekLine === undefined ? undefined : hunkAt(state.hunks, peekLine);
  // Revert lands unsaved, for the person's own Save: a hunk worked out on text that has moved
  // since does nothing (the marks are worked out again, and the peek shows the new one).
  const revert = () => {
    if (hunk && gutter.revert(hunk)) setPeekLine(undefined);
  };
  const peek = hunk && {
    after: Math.max(...hunk.marks) - 1,
    content: <HunkPeek hunk={hunk} onRevert={revert} onClose={() => setPeekLine(undefined)} />,
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "F7" || event.altKey || event.metaKey || event.ctrlKey) return false;
    const next = stepHunk(state.hunks, peekLine, event.shiftKey ? -1 : 1);
    if (!next) return false;
    setPeekLine(next.marks[0]);
    requestReveal(threadId, { path, group, line: next.start, focus: true });
    return true;
  };

  return {
    // Always a map, even an empty one: the live marks are the gutter's only marks.
    marks: state.marks ?? noMarks,
    agentMarks,
    head: commit,
    hunks: state.hunks,
    onMarkClick: setPeekLine,
    peek,
    edited,
    onKey,
  };
}
