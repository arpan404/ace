import type { ComposerToken } from "@ace/ui-core";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { MentionChip } from "@/components/mention-chip.tsx";
import { editorCaret, editorText, editorTokenTexts, placeEditorCaret } from "./editor-dom.ts";
import { editorInSync } from "./editor-sync.ts";

type Props = Omit<ComponentProps<"div">, "onChange" | "children" | "ref"> & {
  input: RefObject<HTMLDivElement | null>;
  text: string;
  tokens: readonly ComposerToken[];
  placeholder: string;
  autoFocus?: boolean | undefined;
  disabled: boolean;
  onChange(text: string, caret: number): void;
  onCaret(caret: number): void;
  /** Undo or Redo asked from outside the keyboard (the Edit menu, a context menu). */
  onHistory?: ((step: "undo" | "redo") => void) | undefined;
};
type Slot = { node: HTMLElement; token: ComposerToken };

/** Build the editor's children for `text`, a chip slot for each token. */
function render(el: HTMLElement, text: string, tokens: readonly ComposerToken[]): Slot[] {
  const children: Node[] = [];
  const slots: Slot[] = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start > at) children.push(document.createTextNode(text.slice(at, token.start)));
    const node = document.createElement("span");
    node.contentEditable = "false";
    node.dataset.tokenText = text.slice(token.start, token.end);
    node.setAttribute("aria-label", token.label);
    children.push(node);
    slots.push({ node, token });
    at = token.end;
  }
  children.push(document.createTextNode(text.slice(at)));
  if (text.endsWith("\n")) {
    const tail = document.createElement("br");
    tail.dataset.editorTail = "";
    children.push(tail);
  }
  el.replaceChildren(...children);
  return slots;
}

/**
 * Native editing owns the DOM while typing: the editor is rebuilt only when the text changes
 * from outside or its chips change, never per keystroke, so the caret, selection and IME stay
 * the browser's.
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
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    if (editorInSync({ text: editorText(el), tokens: editorTokenTexts(el) }, text, tokens)) {
      if (previous.current === tokens) return;
      previous.current = tokens;
      // Chips moved with the text around them: point each at its token, keep the DOM.
      const nodes = [...el.querySelectorAll<HTMLElement>("[data-token-text]")];
      setSlots((current) =>
        current.length === nodes.length &&
        current.every((slot, index) => slot.node === nodes[index] && slot.token === tokens[index])
          ? current
          : nodes.flatMap((node, index) => {
              const token = tokens[index];
              return token ? [{ node, token }] : [];
            }),
      );
      return;
    }
    previous.current = tokens;
    const caret = editorCaret(el);
    setSlots(render(el, text, tokens));
    if (document.activeElement === el) placeEditorCaret(el, Math.min(caret, text.length));
  }, [input, text, tokens]);
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
    el.addEventListener("beforeinput", listener);
    return () => el.removeEventListener("beforeinput", listener);
  }, [input]);
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
        onInput={(event) => {
          const el = event.currentTarget;
          const next = !tokens.length && el.textContent === "" ? "" : editorText(el);
          onChange(next, next.length ? editorCaret(el) : 0);
        }}
        onKeyUp={(event) => onCaret(editorCaret(event.currentTarget))}
        onMouseUp={(event) => {
          if (!editorText(event.currentTarget).length) placeEditorCaret(event.currentTarget, 0);
          onCaret(editorCaret(event.currentTarget));
        }}
      />
      {slots.map(({ node, token }) =>
        createPortal(
          <MentionChip
            name={token.label}
            kind={token.catalog?.kind ?? (token.thread ? "thread" : "file")}
          />,
          node,
        ),
      )}
    </>
  );
}
