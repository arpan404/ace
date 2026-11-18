// oxlint-disable react/no-array-index-key -- a line's row key is its number; there is no other identity.
// oxlint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the hidden textarea takes the keyboard; the scroller handles mouse selection.
import type { Position, Selection } from "@ace/editor";
import { pathParts, type LineMark } from "@ace/ui-core";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type Ref,
} from "react";
import { cn } from "@/lib/cn.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { copyText, deleteForward, deleteSelections } from "./editing.ts";
import { EditorFindBar } from "./find-bar.tsx";
import type { MatchSegment } from "./find-matches.ts";
import {
  charWidthFor,
  fallbackCharWidth,
  gutterWidth,
  lineHeight,
  lineWidth,
  visualColumn,
} from "./geometry.ts";
import { useEditorKeys } from "./keys.ts";
import { CaretLayers } from "./layers.tsx";
import { EditorLine } from "./line.tsx";
import { usePointerSelection } from "./pointer.ts";
import { useEditorDocument } from "./use-editor.ts";
import { useFindResults } from "./use-find.ts";

const overscan = 8;
/** Files up to this many lines mount every row, as the Files viewer always has. */
const mountAll = 400;
const paddingRight = 24;
const noLines = [""];
const normalized = (text: string) => text.replace(/\r\n?/g, "\n");

/** What the editor exposes to code that needs to place a caret or read the text. */
export interface EditorHandle {
  focus(): void;
  text(): string;
  selections(): readonly Selection[];
  setSelections(selections: readonly Selection[]): void;
}

export interface CodeEditorProps {
  /** The text when the editor opens; later edits live in the document, not this prop. */
  text: string;
  /** The file's path: its language, its comment token and the name the textarea announces. */
  path: string;
  readOnly?: boolean;
  /** Gutter marks from the checkout's diff; unset, the editor diffs against its own opening. */
  marks?: ReadonlyMap<number, LineMark> | undefined;
  /** A 1-based line to bring into view once. */
  line?: number | undefined;
  /** Find from the Files toolbar (read-only mode): highlight this query and reveal its hit. */
  find?: { query: string; hit?: { line: number; column: number } | undefined } | undefined;
  /** The line area's region name for assistive tech. */
  label: string;
  onTextChange?: ((text: string) => void) | undefined;
  onSave?: (() => void) | undefined;
  /** Idle time that ends a typing run, as one undo step. */
  commitAfter?: number;
  /** How long typing settles before colours are rebuilt; tests stretch it. */
  highlightDelay?: number;
  focusOnMount?: boolean;
  className?: string;
  ref?: Ref<EditorHandle>;
}

/**
 * The Files tab's text editor: virtualized lines with a sticky line-number gutter, selections
 * and carets drawn over them, and one hidden textarea taking every input. The text core, its
 * cursors, undo and find are the Rust document in `@ace/editor`; this file is the surface.
 */
export function CodeEditor({ ref, ...props }: CodeEditorProps) {
  const readOnly = props.readOnly ?? false;
  const state = useEditorDocument({
    text: props.text,
    path: props.path,
    original: props.marks ? undefined : props.text,
    ...(props.onTextChange ? { onTextChange: props.onTextChange } : {}),
    ...(props.commitAfter === undefined ? {} : { commitAfter: props.commitAfter }),
    ...(props.highlightDelay === undefined ? {} : { highlightDelay: props.highlightDelay }),
  });
  const doc = state.doc;
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const justComposed = useRef(false);
  const [composingText, setComposingText] = useState<string>();
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [content, setContent] = useState<{ doc: unknown; width: number }>({
    doc: undefined,
    width: 0,
  });
  const [cell, setCell] = useState(fallbackCharWidth);
  const [paint, setPaint] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const viewport = useElementSize(scroller);

  const name = pathParts(props.path).name;
  const lineCount = doc?.lenLines() ?? 0;
  const height = Math.max(120, viewport.height);
  const all = lineCount <= mountAll;
  const first = all ? 0 : Math.max(0, Math.floor(scroll.top / lineHeight) - overscan);
  const last = all
    ? lineCount
    : Math.min(lineCount, Math.ceil((scroll.top + height) / lineHeight) + overscan);
  // Visible lines only: one Wasm call per render, and the visible count is small.
  const lines = doc ? doc.lines(first, last) : noLines;
  const gutter = gutterWidth(lineCount);
  const lineAt = useCallback(
    (line: number): string => {
      if (line >= first && line < first + lines.length) return lines[line - first] ?? "";
      return doc?.line(line) ?? "";
    },
    [doc, first, lines],
  );

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) setCell(charWidthFor(getComputedStyle(element).font));
  }, []);

  useEffect(() => {
    const highlighter = state.highlighter;
    if (!highlighter || !doc) return;
    const stop = highlighter.subscribe(() => setPaint((value) => value + 1));
    // After subscribing, so the first pass cannot finish before anyone listens.
    highlighter.setText(doc.text());
    return stop;
  }, [state.highlighter, doc]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let widest = 0;
    for (const text of lines) widest = Math.max(widest, lineWidth(element, text, cell));
    const width = gutter + widest + paddingRight;
    setContent((previous) =>
      previous.doc === doc ? { doc, width: Math.max(previous.width, width) } : { doc, width },
    );
  }, [doc, lines, cell, gutter]);
  const contentWidth = content.doc === doc ? content.width : 0;

  const internal = useFindResults(doc, state.version, {
    active: findOpen,
    query,
    regex,
    caseSensitive,
    wholeWord,
  });
  const external = useFindResults(doc, state.version, {
    active: !findOpen && !!props.find?.query,
    query: findOpen ? "" : (props.find?.query ?? ""),
    caseSensitive: false,
  });
  const results = findOpen ? internal : external;
  const activeQuery = findOpen ? query : (props.find?.query ?? "");
  const externalIndex = useMemo(() => {
    const hit = props.find?.hit;
    if (!hit) return -1;
    return results.matches.findIndex(
      (range) => range.start.line === hit.line && range.start.column === hit.column,
    );
  }, [results.matches, props.find?.hit]);
  const index = results.matches.length ? Math.min(matchIndex, results.matches.length - 1) : 0;
  const currentIndex = findOpen ? index : externalIndex;

  const primary = state.selections[state.primary] ?? state.selections[0];
  const caretLine = primary?.head.line ?? 0;
  const caretColumn = primary?.head.column ?? 0;

  const reveal = useCallback(
    (position: Position) => {
      const element = scroller.current;
      if (!element) return;
      const top = position.line * lineHeight;
      const heightNow = element.clientHeight || viewport.height;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + lineHeight > element.scrollTop + heightNow)
        element.scrollTop = top + lineHeight - heightNow;
      const text = state.doc?.line(position.line) ?? "";
      const x = gutter + visualColumn(text, position.column) * cell;
      const width = element.clientWidth || viewport.width;
      if (x < element.scrollLeft + gutter) element.scrollLeft = Math.max(0, x - gutter);
      else if (x > element.scrollLeft + width - paddingRight)
        element.scrollLeft = x - width + paddingRight * 2;
      setScroll({ top: element.scrollTop, left: element.scrollLeft });
    },
    [state.doc, gutter, cell, viewport.height, viewport.width, setScroll],
  );

  useEffect(() => {
    if (props.line && props.line > 0) reveal({ line: props.line - 1, column: 0 });
  }, [props.line, reveal]);

  const hitLine = props.find?.hit?.line;
  const hitColumn = props.find?.hit?.column;
  useEffect(() => {
    if (hitLine !== undefined && hitColumn !== undefined)
      reveal({ line: hitLine, column: hitColumn });
  }, [hitLine, hitColumn, reveal]);

  const openFind = useCallback(() => {
    const target = state.doc;
    if (!findOpen && target) {
      const selection = target.selections()[target.primarySelection()];
      if (selection && selection.anchor.line === selection.head.line) {
        const text = target.line(selection.anchor.line);
        const start = Math.min(selection.anchor.column, selection.head.column);
        const end = Math.max(selection.anchor.column, selection.head.column);
        if (end > start && end - start <= 200) setQuery(text.slice(start, end));
      }
    }
    setFindOpen(true);
  }, [findOpen, state.doc, setFindOpen, setQuery]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    input.current?.focus({ preventScroll: true });
  }, [setFindOpen]);

  const onKeyDown = useEditorKeys({
    state,
    readOnly,
    path: props.path,
    rows: Math.max(1, Math.floor(height / lineHeight)),
    onFind: openFind,
    ...(props.onSave ? { onSave: props.onSave } : {}),
    onEscape: () => {
      if (!findOpen) return false;
      closeFind();
      return true;
    },
    reveal,
  });

  const step = (delta: 1 | -1) => {
    const count = results.matches.length;
    if (!count) return;
    const next = (((index + delta) % count) + count) % count;
    setMatchIndex(next);
    const range = results.matches[next];
    if (!range) return;
    state.select([{ anchor: range.start, head: range.end }]);
    reveal(range.start);
  };

  const byLine = useMemo(() => {
    const found = new Map<number, MatchSegment[]>();
    results.matches.forEach((range) => {
      if (range.end.line < first || range.start.line > last - 1) return;
      const currentMatch = results.matches[currentIndex] === range;
      for (
        let line = Math.max(first, range.start.line);
        line <= Math.min(last - 1, range.end.line);
        line++
      ) {
        const start = line === range.start.line ? range.start.column : 0;
        const end = line === range.end.line ? range.end.column : Number.MAX_SAFE_INTEGER;
        const list = found.get(line) ?? [];
        list.push({ start, end, current: currentMatch });
        found.set(line, list);
      }
    });
    return found;
  }, [results.matches, first, last, currentIndex]);

  // Read every render: `paint` changes when the highlighter answers, and only visible lines cost.
  void paint;
  const tokens = state.highlighter?.tokens(first, last) ?? [];

  const insert = (text: string) => {
    if (readOnly || !text) return;
    state.edit((target) => target.insertText(text));
  };
  const handled = useRef(false);

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
      insert(normalized(native.data));
    }
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
    insert(normalized(event.clipboardData.getData("text/plain")));
  };

  const pointer = usePointerSelection({
    state,
    cell,
    gutter,
    element: host,
    focus: () => input.current?.focus({ preventScroll: true }),
    reveal,
  });

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus({ preventScroll: true }),
    text: () => state.doc?.text() ?? props.text,
    selections: () => state.doc?.selections() ?? [],
    setSelections: (selections: readonly Selection[]) => state.select(selections),
  }));

  const textareaLeft = gutter + visualColumn(lineAt(caretLine), caretColumn) * cell - scroll.left;
  const textareaTop = caretLine * lineHeight - scroll.top;

  if (state.failed)
    return (
      <div
        role="region"
        aria-label={props.label}
        className={cn("min-h-0 overflow-auto", props.className)}
      >
        <pre className="p-2 pr-6 font-mono text-ui leading-[22px] whitespace-pre">{props.text}</pre>
      </div>
    );

  return (
    <div
      role="region"
      aria-label={props.label}
      className={cn("relative h-full min-h-0", props.className)}
    >
      <div
        ref={scroller}
        data-editor-scroller
        className="h-full min-h-0 overflow-auto focus-ring-inset"
        onScroll={(event) => {
          const element = event.currentTarget;
          setScroll({ top: element.scrollTop, left: element.scrollLeft });
        }}
        onPointerDown={pointer.onPointerDown}
        onPointerMove={pointer.onPointerMove}
        onPointerUp={pointer.onPointerUp}
        onPointerCancel={pointer.onPointerUp}
        onDoubleClick={pointer.onDoubleClick}
        onClick={pointer.onTripleClick}
      >
        <div
          ref={host}
          className="relative min-h-full"
          style={{ height: lineCount * lineHeight, width: contentWidth || "100%" }}
        >
          <div aria-hidden>
            {lines.map((text, offset) => {
              const line = first + offset;
              return (
                <EditorLine
                  key={line}
                  index={line}
                  text={text}
                  tokens={tokens[offset]}
                  gutter={gutter}
                  top={line * lineHeight}
                  mark={(props.marks ?? state.marks)?.get(line + 1)}
                  current={line === caretLine}
                  matches={activeQuery ? byLine.get(line) : undefined}
                  query={activeQuery}
                />
              );
            })}
            <CaretLayers
              selections={state.selections}
              lines={lineAt}
              first={first}
              last={last - 1}
              gutter={gutter}
              cell={cell}
              composing={
                composingText === undefined
                  ? undefined
                  : { position: { line: caretLine, column: caretColumn }, text: composingText }
              }
            />
          </div>
        </div>
      </div>
      {doc ? (
        <textarea
          ref={input}
          aria-label={name}
          aria-multiline="true"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          readOnly={readOnly}
          autoFocus={props.focusOnMount}
          onKeyDown={onKeyDown}
          onBeforeInput={onBeforeInput}
          onInput={(event) => {
            if (composing.current) return;
            const value = event.currentTarget.value;
            if (!value) return;
            event.currentTarget.value = "";
            if (handled.current) {
              handled.current = false;
              return;
            }
            insert(normalized(value));
          }}
          onCopy={onCopy}
          onCut={onCut}
          onPaste={onPaste}
          onCompositionStart={() => {
            composing.current = true;
            setComposingText("");
          }}
          onCompositionUpdate={(event) => setComposingText(event.data)}
          onCompositionEnd={(event) => {
            composing.current = false;
            justComposed.current = true;
            // React synthesises a beforeinput from compositionend where the browser has none.
            queueMicrotask(() => {
              justComposed.current = false;
            });
            setComposingText(undefined);
            event.currentTarget.value = "";
            insert(normalized(event.data));
          }}
          className="absolute size-px resize-none overflow-hidden border-0 bg-transparent p-0 font-mono text-ui text-transparent caret-transparent outline-none"
          style={{ left: textareaLeft, top: textareaTop }}
        />
      ) : null}
      <span aria-live="polite" className="sr-only">
        {`Line ${caretLine + 1}, column ${caretColumn + 1}`}
      </span>
      {findOpen ? (
        <EditorFindBar
          query={query}
          count={internal.matches.length}
          index={index}
          status={internal.status}
          regex={regex}
          caseSensitive={caseSensitive}
          wholeWord={wholeWord}
          onQuery={(next) => {
            setQuery(next);
            setMatchIndex(0);
          }}
          onToggle={(option) => {
            if (option === "regex") setRegex((value) => !value);
            if (option === "caseSensitive") setCaseSensitive((value) => !value);
            if (option === "wholeWord") setWholeWord((value) => !value);
            setMatchIndex(0);
          }}
          onStep={step}
          onClose={closeFind}
        />
      ) : null}
    </div>
  );
}
