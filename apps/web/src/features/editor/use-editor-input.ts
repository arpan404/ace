import type { ClipboardEvent, CompositionEvent, DragEvent, FormEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { copyText, deleteForward, deleteSelections, deleteWordForward } from "./editing.ts";
import { isMacPlatform } from "./keys.ts";
import type { EditorDocumentState } from "./use-editor.ts";

/*
 * Everything the hidden textarea sends: typed text, paste, copy and cut over every selection,
 * deletes and the IME's composition. Editing keys are handled here first (a native `beforeinput`
 * listener covers what the keyboard did not); the document owns the text.
 */

/** Line endings to the document's own `\n` form, whatever the clipboard or IME sent. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export interface EditorInputHandlers {
  composingText: string | undefined;
  /** True when an editing key was applied; the caller then skips its navigation keys. */
  onKeyDown(event: {
    key: string;
    keyCode: number;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    nativeEvent: { isComposing?: boolean };
    preventDefault(): void;
  }): boolean;
  onInput(event: FormEvent<HTMLTextAreaElement>): void;
  onCopy(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onCut(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onDrop(event: DragEvent<HTMLTextAreaElement>): void;
  onCompositionStart(): void;
  onCompositionUpdate(event: CompositionEvent<HTMLTextAreaElement>): void;
  onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>): void;
}

export function useEditorInput(
  state: EditorDocumentState,
  readOnly: boolean,
  field: RefObject<HTMLTextAreaElement | null>,
): EditorInputHandlers {
  const [composingText, setComposingText] = useState<string>();
  const composing = useRef(false);
  const justComposed = useRef(false);
  const handled = useRef(false);
  /** An editing key already applied this tick; a beforeinput that follows must not apply it again. */
  const suppressed = useRef(false);
  const doc = state.doc;
  const mac = isMacPlatform();

  const insert = (text: string) => {
    if (readOnly || !text) return;
    state.edit((target) => target.insertText(text));
  };

  const suppress = () => {
    suppressed.current = true;
    queueMicrotask(() => {
      suppressed.current = false;
    });
  };

  const onBeforeInput = (event: InputEvent) => {
    if (justComposed.current) {
      justComposed.current = false;
      event.preventDefault();
      return;
    }
    if (suppressed.current) return;
    const block = () => {
      event.preventDefault();
      handled.current = true;
    };
    handled.current = false;
    if (readOnly || composing.current) {
      block();
      return;
    }
    const type = event.inputType ?? "";
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
    if (type === "deleteContentForward") {
      block();
      state.edit(deleteForward);
      return;
    }
    if (type === "deleteWordForward") {
      block();
      state.edit(deleteWordForward);
      return;
    }
    if (type === "historyUndo" || type === "historyRedo") {
      block();
      state.edit((target) => (type === "historyUndo" ? target.undo() : target.redo()));
      return;
    }
    if (event.data !== null && event.data !== undefined) {
      block();
      insert(normaliseNewlines(event.data));
    }
  };

  // React's synthetic beforeinput does not carry every browser's inputType, so the real event
  // is read directly. The keydown path below stays primary where a key produced the edit.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const listener = (event: Event) => onBeforeInput(event as InputEvent);
    element.addEventListener("beforeinput", listener);
    return () => element.removeEventListener("beforeinput", listener);
  });

  const onKeyDown: EditorInputHandlers["onKeyDown"] = (event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (readOnly) return false;
    const word = mac ? event.altKey || event.metaKey : event.ctrlKey || event.altKey;
    if (event.key === "Enter") {
      event.preventDefault();
      suppress();
      state.edit((target) => target.insertNewline());
      return true;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      suppress();
      state.edit((target) => (word ? target.deleteWordBackward() : target.backspace()));
      return true;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      suppress();
      state.edit((target) => (word ? deleteWordForward(target) : deleteForward(target)));
      return true;
    }
    return false;
  };

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const wasHandled = handled.current;
    handled.current = false;
    if (composing.current) return;
    const value = event.currentTarget.value;
    if (!value) return;
    event.currentTarget.value = "";
    if (wasHandled) return;
    // A browser without beforeinput reports the whole insertion here instead.
    insert(normaliseNewlines(value));
  };

  const onCopy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!doc) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copyText(doc));
  };

  const onCut = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!doc || readOnly) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copyText(doc));
    state.edit(deleteSelections);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    if (!readOnly) insert(normaliseNewlines(event.clipboardData.getData("text/plain")));
  };

  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    if (!readOnly) insert(normaliseNewlines(event.dataTransfer.getData("text/plain")));
  };

  const onCompositionStart = () => {
    composing.current = true;
    // oxlint-disable-next-line react/immutability, react-compiler/immutability -- the hidden box must not keep the mirrored line while an IME composes.
    if (field.current) field.current.value = "";
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
    onKeyDown,
    onInput,
    onCopy,
    onCut,
    onPaste,
    onDrop,
    onCompositionStart,
    onCompositionUpdate,
    onCompositionEnd,
  };
}
