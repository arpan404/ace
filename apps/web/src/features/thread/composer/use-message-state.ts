import { editComposerTokens, type ComposerDraft, type ComposerToken } from "@ace/ui-core";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { editorSelection, placeEditorCaret } from "./editor-dom.ts";
import {
  emptyHistory,
  recordEdit,
  redoEdit,
  undoEdit,
  type EditHistory,
  type EditSnapshot,
} from "./edit-history.ts";
import type { ComposerEdit } from "./use-composer-picks.ts";

/**
 * The message being written: its text, chips, caret and the files picked by mention, with the
 * history ⌘Z walks. Typing (`type`) leaves the caret to the browser; the composer's own edits
 * (`edit`) and history steps put it after the change once rendered.
 */
export function useMessageState(input: RefObject<HTMLDivElement | null>, initial: ComposerDraft) {
  "use no memo";
  const [text, setText] = useState(initial.text);
  const [tokens, setTokens] = useState<readonly ComposerToken[]>(initial.tokens ?? []);
  const [caret, setCaret] = useState(initial.text.length);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(initial.mentions));
  const history = useRef<EditHistory>(emptyHistory);
  // Where to put the caret once a composer edit has rendered.
  const placeCaret = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || placeCaret.current === undefined) return;
    placeEditorCaret(el, placeCaret.current);
    placeCaret.current = undefined;
  });
  const show = (next: EditSnapshot) => {
    setTokens(next.tokens);
    setText(next.text);
    setCaret(next.caret);
  };
  const record = (next: EditSnapshot) => {
    history.current = recordEdit(history.current, { text, tokens, caret }, next);
    show(next);
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
      tokens: next.tokens ?? editComposerTokens(text, next.text, tokens),
      caret: next.caret,
    });
    placeCaret.current = next.caret;
    input.current?.focus();
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
      placeCaret.current = at;
    },
    /** What the person typed, as the editor now shows it. */
    type: (next: string, at: number) =>
      record({ text: next, tokens: editComposerTokens(text, next, tokens), caret: at }),
    /** The composer's own change: a chip, a recalled message. */
    edit,
    /** ⇧↵: a line break in place of the selection. */
    newline: () => {
      const range = input.current && editorSelection(input.current);
      if (!range) return;
      const next = text.slice(0, range.start) + "\n" + text.slice(range.end);
      edit({ text: next, caret: range.start + 1 });
    },
    /** Undo or redo; the snapshot shown, or undefined when there was nothing to step to. */
    step: (direction: "undo" | "redo"): EditSnapshot | undefined => {
      const walk = direction === "undo" ? undoEdit : redoEdit;
      const taken = walk(history.current, { text, tokens, caret });
      if (!taken) return undefined;
      history.current = taken.history;
      show(taken.snapshot);
      placeCaret.current = taken.snapshot.caret;
      return taken.snapshot;
    },
    remember: (path: string) => setPicked((paths) => new Set(paths).add(path)),
  };
}
