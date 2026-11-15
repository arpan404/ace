import {
  blocksText,
  composerBlocks,
  pointOffset,
  serializeBlocks,
  type ComposerToken,
} from "@ace/ui-core";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentProps,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { FileMarkerChip, MentionChip } from "@/components/mention-chip.tsx";
import { editorCaret, editorSelection, editorText, placeEditorSelection } from "./editor-dom.ts";
import { pointAt, readEditor } from "./editor-read.ts";
import { editorShows, renderEditor, type Slot } from "./editor-render.ts";
import { samePlain } from "./same-plain.ts";

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
  /**
   * Words about to be typed at the caret; true when the composer put them in itself (bold or
   * plain, as ⌘B at a bare caret asked), so the browser doesn't.
   */
  onTypeText?: ((typed: string) => boolean) | undefined;
};

/**
 * What the editor shows, read off the DOM: the Markdown, the caret in it, and the chips still
 * there at their new places (the same list when none moved or went). Deleting one of two chips
 * side by side takes that one; a chip the editor never made (a dropped copy) is no chip.
 */
function shown(el: HTMLElement, slots: readonly Slot[], tokens: readonly ComposerToken[]) {
  const bySlot = new Map(slots.map((slot) => [slot.node, slot.token]));
  const read = readEditor(el, (node) => bySlot.get(node));
  const written = serializeBlocks(read.blocks);
  const selection = el.ownerDocument.getSelection();
  const focus = selection?.focusNode;
  const caret =
    focus && el.contains(focus)
      ? pointOffset(written, pointAt(read, focus, selection.focusOffset))
      : written.text.length;
  const moved = written.tokens.map((token) => {
    const before = tokens.find((each) => each.label === token.label && sameToken(each, token));
    return before && before.start === token.start && before.end === token.end ? before : token;
  });
  const same =
    moved.length === tokens.length && moved.every((token, index) => token === tokens[index]);
  return { text: written.text, caret, tokens: same ? tokens : moved, clean: read.clean };
}

/** The same chip at any place: everything but where it is. */
/** Copy or cut: the words as seen (`blocksText`), never the Markdown or a chip's own drawing. */
function copyShown(event: ClipboardEvent<HTMLDivElement>, slots: readonly Slot[]): boolean {
  const el = event.currentTarget;
  const selection = el.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (!range || range.collapsed || !el.contains(range.commonAncestorContainer)) return false;
  const bySlot = new Map(slots.map((slot) => [slot.node, slot.token]));
  const read = readEditor(el, (node) => bySlot.get(node));
  const from = pointAt(read, range.startContainer, range.startOffset);
  const to = pointAt(read, range.endContainer, range.endOffset);
  event.clipboardData.setData("text/plain", blocksText(read.blocks, from, to));
  event.preventDefault();
  return true;
}

function sameToken(a: ComposerToken, b: ComposerToken): boolean {
  return samePlain({ ...a, start: 0, end: 0 }, { ...b, start: 0, end: 0 });
}

/**
 * The message box as rich text: the person sees bold words, headings, list bullets and chips, never
 * the Markdown that writes them, which is what the composer holds and sends. Native editing owns
 * the DOM while typing: the editor is drawn again only when what it shows no longer matches the
 * text's blocks (a line that just became a heading, `**word**` just closed), never while an IME
 * is composing, so the caret, selection and IME stay the browser's.
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
  onTypeText,
  ...props
}: Props) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const previous = useRef<readonly ComposerToken[] | undefined>(undefined);
  const composing = useRef(false);
  // Bumped when a composition ends, or the browser left something the editor didn't draw, so
  // the editor is drawn again then.
  const [settled, setSettled] = useState(0);
  const blocks = useMemo(() => composerBlocks(text, tokens), [text, tokens]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || composing.current) return;
    const bySlot = new Map(slots.map((slot) => [slot.node, slot.token]));
    if (editorShows(el, blocks, (node) => bySlot.get(node))) {
      if (previous.current === tokens) return;
      previous.current = tokens;
      // Chips moved with the words around them: point each at its token, keep the DOM.
      const nodes = [...el.querySelectorAll<HTMLElement>("[data-token-text]")];
      const ordered = blocks.flatMap((block) =>
        block.runs.flatMap((run) => (run.type === "chip" && run.token ? [run.token] : [])),
      );
      // A chip renamed in place (an edited file) reads by its new name.
      nodes.forEach((node, index) => {
        const label = ordered[index]?.label;
        if (label !== undefined && node.getAttribute("aria-label") !== label)
          node.setAttribute("aria-label", label);
      });
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
    const selection = focused ? editorSelection(el) : undefined;
    setSlots(renderEditor(el, blocks));
    if (selection)
      placeEditorSelection(
        el,
        Math.min(selection.start, text.length),
        Math.min(selection.end, text.length),
      );
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a composition's end draws what it put off
  }, [input, text, tokens, blocks, slots, settled]);
  useLayoutEffect(() => {
    const el = input.current;
    if (autoFocus && el && !el.closest('[inert], [aria-hidden="true"]')) el.focus();
  }, [autoFocus, input]);
  // The browser's own undo can't follow chips or rebuilt text: the composer's history answers.
  const beforeInput = useEffectEvent((event: InputEvent) => {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      onHistory?.(event.inputType === "historyUndo" ? "undo" : "redo");
      return;
    }
    if (
      event.inputType === "insertText" &&
      !event.isComposing &&
      event.data &&
      onTypeText?.(event.data)
    )
      event.preventDefault();
  });
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const listener = (event: InputEvent) => beforeInput(event);
    el.addEventListener("beforeinput", listener);
    return () => el.removeEventListener("beforeinput", listener);
  }, [input]);
  const report = (el: HTMLElement, typing: boolean) => {
    const now = shown(el, slots, tokens);
    onChange(now.text, now.caret, typing, now.tokens);
    // What the browser left isn't the editor's own drawing (a dropped copy of a chip, a stray
    // element): draw it again even when the words read the same.
    if (!now.clean && !typing) setSettled((value) => value + 1);
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
          if (!text.length && !tokens.length) placeEditorSelection(event.currentTarget, 0, 0);
          props.onFocus?.(event);
        }}
        onDragStart={(event) => {
          // A chip can't be dragged: the browser would drop a copy that stands for no file.
          const selection = event.currentTarget.ownerDocument.getSelection();
          const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
          const target = event.target instanceof Node ? event.target : null;
          const chips = [...event.currentTarget.querySelectorAll("[data-token-text]")];
          if (chips.some((chip) => range?.intersectsNode(chip) || chip.contains(target)))
            event.preventDefault();
          props.onDragStart?.(event);
        }}
        onCopy={(event) => {
          copyShown(event, slots);
          props.onCopy?.(event);
        }}
        onCut={(event) => {
          // The words go to the clipboard as seen; the browser's own delete takes them out.
          if (copyShown(event, slots)) event.currentTarget.ownerDocument.execCommand?.("delete");
          props.onCut?.(event);
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
          if (!editorText(event.currentTarget).length)
            placeEditorSelection(event.currentTarget, 0, 0);
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
