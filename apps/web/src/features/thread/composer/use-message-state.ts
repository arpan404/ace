import {
  applyTextChange,
  boldAt,
  boldEndsAt,
  breakLine,
  clearLineStyle,
  editComposerTokens,
  typeStyled,
  indentList,
  insertAttachmentMarkers,
  mapTextOffset,
  mapTextTokens,
  markerKeys,
  pruneAttachmentMarkers,
  renumberEdits,
  strayMarkerEdits,
  typedListChange,
  toggleBold,
  applyTextEdits,
  type ComposerDraft,
  type ComposerEdited,
  type ComposerToken,
  type TextChange,
} from "@ace/ui-core";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { editorLineStart, editorSelection, placeEditorSelection } from "./editor-dom.ts";
import {
  emptyHistory,
  mapHistoryTokens,
  recordEdit,
  redoEdit,
  undoEdit,
  type EditHistory,
  type EditSnapshot,
} from "./edit-history.ts";
import type { ComposerEdit } from "./use-composer-picks.ts";

/** The files whose markers an edit took out of the text. */
function goneMarkers(before: readonly ComposerToken[], after: readonly ComposerToken[]): number[] {
  if (before === after) return [];
  const kept = new Set(markerKeys(after));
  return markerKeys(before).filter((key) => !kept.has(key));
}

/**
 * The message being written: its text, chips, caret and the files picked by mention, with the
 * history ⌘Z walks. Typing (`type`) leaves the caret to the browser; the composer's own edits
 * (`edit`) and history steps put it after the change once rendered. An edit that takes a file's
 * marker out of the text tells `onMarkersGone`, so the file goes with it.
 */
export function useMessageState(
  input: RefObject<HTMLDivElement | null>,
  initial: ComposerDraft,
  onMarkersGone: (keys: number[]) => void = () => {},
) {
  "use no memo";
  const [text, setText] = useState(initial.text);
  const [tokens, setTokens] = useState<readonly ComposerToken[]>(initial.tokens ?? []);
  const [caret, setShownCaret] = useState(initial.text.length);
  // The message as of the last change, ahead of the next render: two events in one task (typing,
  // then a paste that adds a file) each build on what the one before left, never on the words
  // the last render saw.
  const live = useRef<EditSnapshot>({ text, tokens, caret });
  const setCaret = (at: number) => {
    live.current = { ...live.current, caret: at };
    setShownCaret(at);
  };
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(initial.mentions));
  const history = useRef<EditHistory>(emptyHistory);
  // Where to put the selection once a composer edit has rendered.
  const placeSelection = useRef<{ start: number; end: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const el = input.current;
    const place = placeSelection.current;
    if (!el || place === undefined) return;
    placeEditorSelection(el, place.start, place.end);
    placeSelection.current = undefined;
  });
  const show = (next: EditSnapshot) => {
    live.current = next;
    setTokens(next.tokens);
    setText(next.text);
    setShownCaret(next.caret);
  };
  const record = (next: EditSnapshot) => {
    const before = live.current;
    history.current = recordEdit(history.current, before, next);
    show(next);
    const gone = goneMarkers(before.tokens, next.tokens);
    if (gone.length) onMarkersGone(gone);
  };
  /** Replace the whole message (another window's draft, a cleared composer): history restarts. */
  const take = (next: ComposerDraft) => {
    history.current = emptyHistory;
    show({ text: next.text, tokens: next.tokens ?? [], caret: next.text.length });
    setPicked(new Set(next.mentions));
  };
  const edit = (next: ComposerEdit) => {
    record({
      text: next.text,
      tokens: next.tokens ?? editComposerTokens(live.current.text, next.text, live.current.tokens),
      caret: next.caret,
    });
    placeSelection.current = { start: next.caret, end: next.caret };
    input.current?.focus();
  };
  // What ⌘B at a bare caret asked for the next words typed there: bold, or plain.
  const pending = useRef<{ at: number; bold: boolean } | undefined>(undefined);
  /** An edit the composer made of what the person sees, the caret after it. */
  const commit = (edited: ComposerEdited) => {
    record({ text: edited.text, tokens: edited.tokens, caret: edited.caret });
    placeSelection.current = { start: edited.caret, end: edited.caret };
  };
  /** A list or bold change made where the selection is now. */
  const change = (made: (selection: { start: number; end: number }) => TextChange | undefined) => {
    const range = input.current && editorSelection(input.current);
    if (!range) return false;
    const changed = made(range);
    if (!changed) return false;
    const was = live.current;
    const after = applyTextChange(was.text, was.tokens, changed);
    const same = after.text === was.text;
    if (!same) record({ text: after.text, tokens: after.tokens, caret: after.selection.end });
    else setCaret(after.selection.end);
    placeSelection.current = after.selection;
    // Nothing to draw again: put the selection back now.
    if (same && input.current)
      placeEditorSelection(input.current, after.selection.start, after.selection.end);
    return true;
  };
  return {
    text,
    tokens,
    caret,
    picked,
    setCaret,
    take,
    /** Put the caret where the next render should leave it. */
    placeCaretAt: (at: number) => {
      placeSelection.current = { start: at, end: at };
    },
    /**
     * What the person typed, as the editor now shows it. Numbered lists count again around the
     * change, except while an IME is still composing the words.
     */
    type: (
      next: string,
      at: number,
      composing = false,
      shown: readonly ComposerToken[] = editComposerTokens(
        live.current.text,
        next,
        live.current.tokens,
      ),
    ) => {
      // A marker character with no file (a dropped copy of a chip) stands for nothing: it goes.
      const strays = strayMarkerEdits(next, shown);
      const words = strays.length ? applyTextEdits(next, strays) : next;
      const typed = strays.length ? mapTextTokens(shown, strays) : shown;
      const caretAt = strays.length ? mapTextOffset(at, strays) : at;
      // Numbers count again only where a list item was added or taken away.
      const listed = composing ? undefined : typedListChange(live.current.text, words);
      const numbers = listed ? renumberEdits(words, new Set(), listed) : [];
      // A space typed at the end of bold words is written after their marks (bold can't end in
      // a space), so the next words typed there carry the bold on, as in a document.
      const spaced =
        words.length === live.current.text.length + 1 &&
        /\s/.test(words[caretAt - 1] ?? "") &&
        boldEndsAt(words, typed, caretAt - 1) &&
        !boldAt(words, typed, caretAt);
      pending.current = spaced ? { at: caretAt, bold: true } : undefined;
      if (!numbers.length) {
        record({ text: words, tokens: typed, caret: caretAt });
        if (strays.length) placeSelection.current = { start: caretAt, end: caretAt };
        return;
      }
      const counted = mapTextOffset(caretAt, numbers);
      record({
        text: applyTextEdits(words, numbers),
        tokens: mapTextTokens(typed, numbers),
        caret: counted,
      });
      placeSelection.current = { start: counted, end: counted };
    },
    /** The composer's own change: a chip, a recalled message. */
    edit,
    /** The newline key: the next list item in a list, else a line break for the selection. */
    newline: () => {
      const range = input.current && editorSelection(input.current);
      if (!range) return;
      commit(breakLine(live.current.text, live.current.tokens, range));
      input.current?.focus();
    },
    /**
     * ⌘B: bold on or off for the selection; at a bare caret, for what is typed next there (no
     * words change until then).
     */
    bold: () => {
      const range = input.current && editorSelection(input.current);
      if (!range) return;
      if (range.start !== range.end)
        return void change(() => toggleBold(live.current.text, range, live.current.tokens));
      const now =
        pending.current?.at === range.start
          ? pending.current.bold
          : boldAt(live.current.text, live.current.tokens, range.start);
      pending.current = { at: range.start, bold: !now };
    },
    /** Words about to be typed: put in bold or plain as ⌘B asked; false to let the browser type. */
    typeText: (typed: string): boolean => {
      const wanted = pending.current;
      const range = input.current && editorSelection(input.current);
      if (!wanted || !range || range.start !== range.end || wanted.at !== range.start) {
        pending.current = undefined;
        return false;
      }
      if (wanted.bold === boldAt(live.current.text, live.current.tokens, range.start)) {
        pending.current = undefined;
        return false;
      }
      const edited = typeStyled(
        live.current.text,
        live.current.tokens,
        range.start,
        typed,
        wanted.bold,
      );
      commit(edited);
      // Spaces alone don't settle it: the words after them are still what ⌘B asked.
      pending.current = typed.trim() ? undefined : { at: edited.caret, bold: wanted.bold };
      return true;
    },
    /** Backspace at the start of a heading or item: off comes its style; false elsewhere. */
    backspace: (): boolean => {
      const line = input.current ? editorLineStart(input.current) : undefined;
      if (line === undefined) return false;
      const cleared = clearLineStyle(live.current.text, live.current.tokens, line);
      if (!cleared) return false;
      commit(cleared);
      return true;
    },
    /** Tab or Shift+Tab: false outside a list, where the key keeps its usual meaning. */
    indent: (outdent: boolean) => change((range) => indentList(live.current.text, range, outdent)),
    /** Mark where files were added: at the caret, or where it last was. */
    markFiles: (files: readonly { key: number; name: string }[]) => {
      if (!files.length) return;
      const focused =
        !!input.current && input.current.ownerDocument.activeElement === input.current;
      const at =
        focused && input.current ? editorSelection(input.current).start : live.current.caret;
      const marked = insertAttachmentMarkers(live.current.text, live.current.tokens, at, files);
      // A step of its own to undo, never part of the word being typed.
      history.current = { ...history.current, run: undefined };
      record({ text: marked.text, tokens: marked.tokens, caret: marked.caret });
      history.current = { ...history.current, run: undefined };
      if (focused) placeSelection.current = { start: marked.caret, end: marked.caret };
    },
    /** Take out the markers of files no longer attached; not a step of its own to undo. */
    prune: (attached: ReadonlySet<number>) => {
      const kept = pruneAttachmentMarkers(live.current.text, live.current.tokens, attached);
      if (kept.tokens === live.current.tokens) return;
      const at = Math.min(live.current.caret, kept.text.length);
      show({ text: kept.text, tokens: kept.tokens, caret: at });
      if (input.current?.ownerDocument.activeElement === input.current)
        placeSelection.current = { start: at, end: at };
    },
    /** A file replaced by an edited copy: its marker names the copy now. */
    rekey: (key: number, fresh: number, name: string) => {
      const renamed = (list: readonly ComposerToken[]) => {
        const next = list.map((token) =>
          token.attachment?.key === key
            ? { ...token, label: name, attachment: { key: fresh } }
            : token,
        );
        return next.some((token, index) => token !== list[index]) ? next : list;
      };
      // Undo and redo find the same marker under the copy's key.
      history.current = mapHistoryTokens(history.current, renamed);
      const next = renamed(live.current.tokens);
      if (next === live.current.tokens) return;
      live.current = { ...live.current, tokens: next };
      setTokens(next);
    },
    /** Undo or redo; the snapshot shown, or undefined when there was nothing to step to. */
    step: (direction: "undo" | "redo"): EditSnapshot | undefined => {
      const walk = direction === "undo" ? undoEdit : redoEdit;
      const taken = walk(history.current, live.current);
      if (!taken) return undefined;
      history.current = taken.history;
      show(taken.snapshot);
      // Undo and redo never add or take away files: a file whose marker this takes away stays
      // attached, with no place, and a step back to its marker puts it back.
      placeSelection.current = { start: taken.snapshot.caret, end: taken.snapshot.caret };
      return taken.snapshot;
    },
    remember: (path: string) => setPicked((paths) => new Set(paths).add(path)),
  };
}
