import { decorateComposerText, type ComposerToken } from "@ace/ui-core";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { FileMarkerChip, MentionChip } from "@/components/mention-chip.tsx";
import { editorCaret, editorChips, editorText, placeEditorCaret } from "./editor-dom.ts";
import { editorSignature, markActiveStyles, renderEditor, type Slot } from "./editor-render.ts";
import { editorInSync } from "./editor-sync.ts";

type Props = Omit<ComponentProps<"div">, "onChange" | "children" | "ref"> & {
  input: RefObject<HTMLDivElement | null>;
  text: string;
  tokens: readonly ComposerToken[];
  placeholder: string;
  autoFocus?: boolean | undefined;
  disabled: boolean;
  /**
   * What the editor shows now: its text, caret and the chips still in it, at their new places;
   * `composing` while an IME is still composing the words.
   */
  onChange(text: string, caret: number, composing: boolean, tokens: readonly ComposerToken[]): void;
  onCaret(caret: number): void;
  /** Undo or Redo asked from outside the keyboard (the Edit menu, a context menu). */
  onHistory?: ((step: "undo" | "redo") => void) | undefined;
};

/**
 * The chips the editor still shows, each at the offset it moved to; the same list when none
 * moved or went. Read off the DOM, so deleting one of two chips side by side takes that one.
 */
function chipsShown(
  el: HTMLElement,
  slots: readonly Slot[],
  tokens: readonly ComposerToken[],
): readonly ComposerToken[] {
  const bySlot = new Map(slots.map((slot) => [slot.node, slot.token]));
  const shown = editorChips(el).flatMap(({ node, start }) => {
    const token = bySlot.get(node);
    if (!token) return [];
    const end = start + (token.end - token.start);
    return [token.start === start ? token : { ...token, start, end }];
  });
  return shown.length === tokens.length && shown.every((token, index) => token === tokens[index])
    ? tokens
    : shown;
}

/**
 * Native editing owns the DOM while typing: the editor is drawn again only when what it shows
 * no longer matches the text's drawing (its Markdown styles and chips), never while an IME is
 * composing, so the caret, selection and IME stay the browser's. Typing inside a style or plain
 * words leaves the DOM alone.
 */
export function MessageInput({
  input,
  text,
  tokens,
  placeholder,
  autoFocus,
  disabled,
  onChange,
  onCaret,
  onHistory,
  ...props
}: Props) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const previous = useRef<readonly ComposerToken[] | undefined>(undefined);
  const composing = useRef(false);
  // Bumped when a composition ends, so a drawing put off while it ran is made then.
  const [settled, setSettled] = useState(0);
  const drawing = useMemo(() => decorateComposerText(text, tokens), [text, tokens]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || composing.current) return;
    if (editorInSync(editorSignature(el), drawing, text, tokens)) {
      if (previous.current === tokens) return;
      previous.current = tokens;
      // Chips moved with the text around them: point each at its token, keep the DOM.
      const nodes = [...el.querySelectorAll<HTMLElement>("[data-token-text]")];
      const ordered = tokens.toSorted((a, b) => a.start - b.start);
      setSlots((current) =>
        current.length === nodes.length &&
        current.every((slot, index) => slot.node === nodes[index] && slot.token === ordered[index])
          ? current
          : nodes.flatMap((node, index) => {
              const token = ordered[index];
              return token ? [{ node, token }] : [];
            }),
      );
      return;
    }
    previous.current = tokens;
    const focused = document.activeElement === el;
    const caret = editorCaret(el);
    setSlots(renderEditor(el, drawing, text, tokens));
    if (focused) {
      placeEditorCaret(el, Math.min(caret, text.length));
      markActiveStyles(el);
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a composition's end draws what it put off
  }, [input, text, tokens, drawing, settled]);
  useLayoutEffect(() => {
    const el = input.current;
    if (autoFocus && el && !el.closest('[inert], [aria-hidden="true"]')) el.focus();
  }, [autoFocus, input]);
  // The browser's own undo can't follow chips or rebuilt text: the composer's history answers.
  const history = useEffectEvent((event: InputEvent) => {
    if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
    event.preventDefault();
    onHistory?.(event.inputType === "historyUndo" ? "undo" : "redo");
  });
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const listener = (event: InputEvent) => history(event);
    // The marks of the bold words or heading the caret is in show; elsewhere they fade.
    const moved = () => {
      if (el.ownerDocument.activeElement === el) markActiveStyles(el);
    };
    el.addEventListener("beforeinput", listener);
    el.ownerDocument.addEventListener("selectionchange", moved);
    return () => {
      el.removeEventListener("beforeinput", listener);
      el.ownerDocument.removeEventListener("selectionchange", moved);
    };
  }, [input]);
  const report = (el: HTMLElement, typing: boolean) => {
    const next = !tokens.length && el.textContent === "" ? "" : editorText(el);
    onChange(next, next.length ? editorCaret(el) : 0, typing, chipsShown(el, slots, tokens));
  };
  return (
    <>
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the caller passes its role (combobox) in props */}
      <div
        {...props}
        ref={input}
        contentEditable={!disabled}
        suppressContentEditableWarning
        aria-disabled={disabled || undefined}
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        data-empty={text.length === 0 ? "true" : undefined}
        onFocus={(event) => {
          if (!text.length && !tokens.length) placeEditorCaret(event.currentTarget, 0);
          props.onFocus?.(event);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          report(event.currentTarget, false);
          setSettled((value) => value + 1);
        }}
        onInput={(event) => report(event.currentTarget, composing.current)}
        onKeyUp={(event) => onCaret(editorCaret(event.currentTarget))}
        onMouseUp={(event) => {
          if (!editorText(event.currentTarget).length) placeEditorCaret(event.currentTarget, 0);
          onCaret(editorCaret(event.currentTarget));
        }}
      />
      {slots.map(({ node, token }) =>
        createPortal(
          token.attachment ? (
            <FileMarkerChip name={token.label} />
          ) : (
            <MentionChip
              name={token.label}
              kind={
                token.catalog?.kind ?? (token.thread ? "thread" : token.browserTab ? "tab" : "file")
              }
            />
          ),
          node,
        ),
      )}
    </>
  );
}
