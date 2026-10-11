import type { ComposerToken } from "@ace/ui-core";
import { useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MentionChip } from "@/components/mention-chip.tsx";
import { editorCaret, editorText, placeEditorCaret } from "./editor-dom.ts";

type Props = Omit<ComponentProps<"div">, "onChange" | "children" | "ref"> & {
  input: RefObject<HTMLDivElement | null>;
  text: string;
  tokens: readonly ComposerToken[];
  placeholder: string;
  autoFocus?: boolean | undefined;
  disabled: boolean;
  onChange(text: string, caret: number): void;
  onCaret(caret: number): void;
};
/** Native editing owns the DOM while typing; external edits rebuild only when needed. */
export function MessageInput({
  input,
  text,
  tokens,
  placeholder,
  autoFocus,
  disabled,
  onChange,
  onCaret,
  ...props
}: Props) {
  const [slots, setSlots] = useState<{ node: HTMLElement; token: ComposerToken }[]>([]);
  const previous = useRef<readonly ComposerToken[]>([]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || (editorText(el) === text && previous.current === tokens)) return;
    const caret = editorCaret(el);
    const children: Node[] = [];
    const next: typeof slots = [];
    let at = 0;
    for (const token of tokens) {
      if (token.start > at) children.push(document.createTextNode(text.slice(at, token.start)));
      const node = document.createElement("span");
      node.contentEditable = "false";
      node.dataset.tokenText = text.slice(token.start, token.end);
      node.setAttribute("aria-label", token.label);
      children.push(node);
      next.push({ node, token });
      at = token.end;
    }
    children.push(document.createTextNode(text.slice(at)));
    if (text.endsWith("\n")) {
      const tail = document.createElement("br");
      tail.dataset.editorTail = "";
      children.push(tail);
    }
    el.replaceChildren(...children);
    previous.current = tokens;
    setSlots(next);
    if (document.activeElement === el) placeEditorCaret(el, Math.min(caret, text.length));
  }, [input, text, tokens]);
  useLayoutEffect(() => {
    const el = input.current;
    if (autoFocus && el && !el.closest('[inert], [aria-hidden="true"]')) el.focus();
  }, [autoFocus, input]);
  return (
    <>
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
