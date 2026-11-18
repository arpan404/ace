import type { ClipboardEvent, CompositionEvent, FormEvent } from "react";
import { useRef, useState } from "react";
import { copyText, deleteForward, deleteSelections } from "./editing.ts";
import type { EditorDocumentState } from "./use-editor.ts";

/*
 * Everything the hidden textarea sends: typed text, paste, copy and cut over every selection,
 * deletes and the IME's composition. The handlers own the textarea's temporary value; the
 * document owns the text.
 */

/** Line endings to the document's own `\n` form, whatever the clipboard or IME sent. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export interface EditorInputHandlers {
  composingText: string | undefined;
  onBeforeInput(event: FormEvent<HTMLTextAreaElement>): void;
  onInput(event: FormEvent<HTMLTextAreaElement>): void;
  onCopy(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onCut(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onCompositionStart(): void;
  onCompositionUpdate(event: CompositionEvent<HTMLTextAreaElement>): void;
  onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>): void;
}

export function useEditorInput(state: EditorDocumentState, readOnly: boolean): EditorInputHandlers {
  const [composingText, setComposingText] = useState<string>();
  const composing = useRef(false);
  const justComposed = useRef(false);
  const handled = useRef(false);
  const doc = state.doc;

  const insert = (text: string) => {
    if (readOnly || !text) return;
    state.edit((target) => target.insertText(text));
  };

  const onBeforeInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    if (justComposed.current) {
      justComposed.current = false;
      event.preventDefault();
      return;
    }
    const block = () => {
      event.preventDefault();
      handled.current = true;
    };
    handled.current = false;
    if (readOnly || composing.current) {
      block();
      return;
    }
    const type = native.inputType ?? "";
    if (type === "insertLineBreak" || type === "insertParagraph") {
      block();
      state.edit((target) => target.insertNewline());
      return;
    }
    if (type === "deleteContentBackward" || type === "deleteSoftLineBackward") {
      block();
      state.edit((target) =>
        type === "deleteSoftLineBackward" ? target.deleteWordBackward() : target.backspace(),
      );
      return;
    }
    if (type === "deleteWordBackward") {
      block();
      state.edit((target) => target.deleteWordBackward());
      return;
    }
    if (type === "deleteContentForward" || type === "deleteWordForward") {
      block();
      state.edit(deleteForward);
      return;
    }
    if (type === "historyUndo" || type === "historyRedo") {
      block();
      state.edit((target) => (type === "historyUndo" ? target.undo() : target.redo()));
      return;
    }
    if (native.data !== null && native.data !== undefined) {
      block();
      insert(normaliseNewlines(native.data));
    }
  };

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;
    const value = event.currentTarget.value;
    if (!value) return;
    event.currentTarget.value = "";
    if (handled.current) {
      handled.current = false;
      return;
    }
    // A browser without beforeinput reports the whole insertion here instead.
    insert(normaliseNewlines(value));
  };

  const onCopy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!doc) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copyText(doc));
  };

  const onCut = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!doc) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copyText(doc));
    state.edit(deleteSelections);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    insert(normaliseNewlines(event.clipboardData.getData("text/plain")));
  };

  const onCompositionStart = () => {
    composing.current = true;
    setComposingText("");
  };

  const onCompositionUpdate = (event: CompositionEvent<HTMLTextAreaElement>) =>
    setComposingText(event.data);

  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false;
    justComposed.current = true;
    // React synthesises a beforeinput from compositionend where the browser has none.
    queueMicrotask(() => {
      justComposed.current = false;
    });
    setComposingText(undefined);
    event.currentTarget.value = "";
    insert(normaliseNewlines(event.data));
  };

  return {
    composingText,
    onBeforeInput,
    onInput,
    onCopy,
    onCut,
    onPaste,
    onCompositionStart,
    onCompositionUpdate,
    onCompositionEnd,
  };
}
