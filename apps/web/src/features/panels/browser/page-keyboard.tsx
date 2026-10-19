import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import type { BrowserPageView, ForwardedInput } from "../sources.ts";
import type { ScreenBox } from "./page-geometry.ts";
import { editInput, keyboardKind, typedEdit, typedLocally } from "./page-typing.ts";

type Focus = NonNullable<BrowserPageView["focus"]>;

const marker = "data-page-keyboard";
/** Keys that move the page's caret elsewhere: what was typed before no longer sits behind it. */
const moves = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const touchKeyboard = () =>
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

/**
 * Whether the page view should leave this key alone: the local field types it (an IME, a dead
 * key, a phone keyboard's letters) and sends it as text. Every other key the pane forwards as
 * a key event, as before.
 */
export function typedByPageKeyboard(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.hasAttribute(marker)) return false;
  return typedLocally(event.nativeEvent, touchKeyboard());
}

/** What the page has of the typed text: the field's value and caret as last replayed. */
interface Synced {
  value: string;
  caret: number;
}
interface Typed {
  synced: Synced;
  /** The composition under way: where it starts in the field (once known) and its text. */
  composing: { from: number | undefined; text: string } | undefined;
}
/** The page's field took focus anew, or the caret moved: typing starts from an empty field. */
function restart(element: HTMLTextAreaElement | null, typed: Typed): void {
  if (element) element.value = "";
  typed.synced = { value: "", caret: 0 };
  typed.composing = undefined;
}

/**
 * A hidden text field over the page's caret. While the page's focused element takes text and
 * the person is working in the pane, the field has focus, so a phone opens its keyboard
 * (matched to the page's field) and an IME composes in it. Composition is shown marked in the
 * page and committed as text; other typing is replayed at the page's caret. When the page's
 * field loses focus the pane takes it back, which closes a phone's keyboard. Its text is large
 * (`text-lg`) because a phone zooms the app to a focused field set smaller than 16px.
 */
export function PageKeyboard(props: {
  focus: Focus | undefined;
  /** The page box's place in the pane, or undefined before the frame is drawn. */
  place(box: Focus["rect"]): ScreenBox | undefined;
  forward(input: ForwardedInput): void;
  pane: RefObject<HTMLElement | null>;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const typed = useRef<Typed>({ synced: { value: "", caret: 0 }, composing: undefined });
  const forward = (inputs: readonly ForwardedInput[]) => {
    for (const input of inputs) props.forward(input);
  };
  const reset = () => restart(field.current, typed.current);
  const { focus, pane } = props;
  // A different field (or the same one after focus moved away and back) starts empty.
  const fieldKey = focus ? `${focus.type}:${focus.rect.x}:${focus.rect.y}` : "";
  // A click in the pane focuses the pane; while the page's field still has focus, typing goes
  // on in the local field (within the tap, so a phone opens its keyboard again).
  const typing = useRef(fieldKey);
  useEffect(() => {
    // First, so handing focus back to the pane below doesn't take it again.
    typing.current = fieldKey;
    const element = field.current;
    const host = pane.current;
    if (!element || !host) return;
    const active = document.activeElement;
    // Only while the person works in the pane: an agent focusing a field never takes the keys.
    const engaged = active === element || (active instanceof Node && host.contains(active));
    if (fieldKey && engaged) {
      restart(element, typed.current);
      if (active !== element) element.focus({ preventScroll: true });
    } else if (!fieldKey && active === element) {
      restart(element, typed.current);
      host.focus({ preventScroll: true });
    }
  }, [fieldKey, pane]);
  useEffect(() => {
    const host = pane.current;
    if (!host) return;
    const regain = () => {
      if (typing.current) field.current?.focus({ preventScroll: true });
    };
    host.addEventListener("focus", regain);
    return () => host.removeEventListener("focus", regain);
  }, [pane]);
  const read = () => {
    const element = field.current;
    return element ? { value: element.value, caret: element.selectionEnd } : undefined;
  };
  const replay = () => {
    const now = read();
    if (!now) return;
    const before = typed.current.synced;
    forward(editInput(typedEdit(before.value, before.caret, now.value, now.caret)));
    typed.current.synced = now;
    // A long run of typing keeps only recent context.
    if (now.value.length > 2000) reset();
  };
  /**
   * Where the composition starts, read once the field shows it. An IME recomposing a word
   * already typed (Android keyboards do) starts behind the caret: that word leaves the page
   * first, so the composition replaces it there too.
   */
  const begin = (text: string) => {
    const composition = typed.current.composing;
    if (!composition || composition.from !== undefined) return;
    const { value, caret } = typed.current.synced;
    const end = field.current?.selectionEnd ?? caret;
    const from = Math.max(0, Math.min(caret, end - text.length));
    composition.from = from;
    const behind = Array.from(value.slice(from, caret)).length;
    if (behind) forward(editInput({ backspaces: behind, deletes: 0, text: "" }));
    typed.current.synced = { value: value.slice(0, from), caret: from };
  };
  const box = focus ? props.place(focus.caret ?? focus.rect) : undefined;
  const kind = focus ? keyboardKind(focus) : undefined;
  return (
    <textarea
      ref={field}
      {...{ [marker]: "" }}
      aria-label="Page text"
      tabIndex={-1}
      autoComplete="off"
      autoCorrect={kind?.assisted ? "on" : "off"}
      autoCapitalize={kind?.assisted ? "sentences" : "off"}
      spellCheck={kind?.assisted ?? false}
      inputMode={kind?.inputMode}
      enterKeyHint={kind?.enterKeyHint}
      rows={1}
      className="pointer-events-none absolute resize-none overflow-hidden border-0 bg-transparent p-0 text-lg text-transparent caret-transparent opacity-0"
      style={
        box
          ? {
              left: box.left,
              top: box.top,
              width: Math.max(1, box.width),
              height: Math.max(1, box.height),
            }
          : { left: 0, top: 0, width: 1, height: 1 }
      }
      onKeyDown={(event) => {
        if (typedLocally(event.nativeEvent, touchKeyboard())) return;
        // The pane sends this key to the page; keep the field in step with what it does there.
        const element = field.current;
        if (!element) return;
        if (event.key === "Backspace" && !event.altKey && !event.metaKey && !event.ctrlKey) {
          const { value, caret } = typed.current.synced;
          const removed = caret > 1 && /[\uDC00-\uDFFF]/.test(value[caret - 1] ?? "") ? 2 : 1;
          const from = Math.max(0, caret - removed);
          element.value = value.slice(0, from) + value.slice(caret);
          element.setSelectionRange(from, from);
          typed.current.synced = { value: element.value, caret: from };
        } else if (moves.has(event.key) || event.metaKey || event.ctrlKey) reset();
      }}
      onCompositionStart={() => {
        typed.current.composing = { from: undefined, text: "" };
      }}
      onCompositionUpdate={(event) => {
        typed.current.composing = { from: typed.current.composing?.from, text: event.data };
      }}
      onCompositionEnd={(event) => {
        const text = event.data;
        begin(text);
        if (text) forward(editInput({ backspaces: 0, deletes: 0, text }));
        else forward([{ kind: "ime", text: "", selectionStart: 0, selectionEnd: 0 }]);
        typed.current.composing = undefined;
        const now = read();
        if (now) typed.current.synced = now;
      }}
      onInput={() => {
        const composition = typed.current.composing;
        if (!composition) {
          replay();
          return;
        }
        // The field shows the composition now: the page shows it marked at its caret.
        begin(composition.text);
        const { text } = composition;
        forward([{ kind: "ime", text, selectionStart: text.length, selectionEnd: text.length }]);
      }}
    />
  );
}
