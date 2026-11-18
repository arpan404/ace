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
  type Ref,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { EditorFindBar } from "./find-bar.tsx";
import type { MatchSegment } from "./find-matches.ts";
import {
  charWidthFor,
  clearMeasurements,
  fallbackCharWidth,
  gutterWidth,
  isPlain,
  lineHeight,
  lineWidth,
  measureElement,
  visualColumn,
} from "./geometry.ts";
import { useEditorKeys } from "./keys.ts";
import type { Token } from "./highlighter.ts";
import { CaretLayers } from "./layers.tsx";
import { EditorLine } from "./line.tsx";
import { usePointerSelection } from "./pointer.ts";
import { useEditorDocument } from "./use-editor.ts";
import { selectedLineSpan } from "./cursor.ts";
import { useEditorInput } from "./use-editor-input.ts";
import { useFindInFile } from "./use-find-in-file.ts";
import { useFindResults } from "./use-find.ts";

const overscan = 8;
/** Files up to this many lines mount every row, as the Files viewer always has. */
const mountAll = 400;
const paddingRight = 24;
const noLines = [""];

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
  /** Called after each edit; read the text through the handle when it is actually needed. */
  onEdit?: (() => void) | undefined;
  onBlur?: (() => void) | undefined;
  /** The text once, as the editor unmounts, for a caller that keeps a draft. */
  onTextDispose?: ((text: string) => void) | undefined;
  onSave?: (() => void) | undefined;
  /** Whether lines run past the editor's right edge, for the toolbar's fade. */
  onHorizontalOverflow?: ((overflow: boolean) => void) | undefined;
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
    editable: !readOnly,
    ...(props.onEdit ? { onEdit: props.onEdit } : {}),
    ...(props.onTextDispose ? { onTextDispose: props.onTextDispose } : {}),
    ...(props.commitAfter === undefined ? {} : { commitAfter: props.commitAfter }),
    ...(props.highlightDelay === undefined ? {} : { highlightDelay: props.highlightDelay }),
  });
  const doc = state.doc;
  const seenText = useRef(props.text);
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [content, setContent] = useState<{ doc: unknown; width: number }>({
    doc: undefined,
    width: 0,
  });
  const [cell, setCell] = useState(fallbackCharWidth);
  const [paint, setPaint] = useState(0);
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number }>();
  const viewport = useElementSize(scroller);
  const input = useEditorInput(state, readOnly, field);

  const name = pathParts(props.path).name;
  const lineCount = doc?.lenLines() ?? 0;
  const height = Math.max(120, viewport.height);
  const all = lineCount <= mountAll;
  const first = all ? 0 : Math.max(0, Math.floor(scroll.top / lineHeight) - overscan);
  const last = all
    ? lineCount
    : Math.min(lineCount, Math.ceil((scroll.top + height) / lineHeight) + overscan);
  const [lines, setLines] = useState<string[]>(noLines);
  const linesKey = `${state.version}:${first}:${last}`;
  useEffect(() => {
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- the document is an external store; its lines change under React.
    setLines(doc ? doc.lines(first, last) : noLines);
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- first and last are already in the key.
  }, [linesKey, doc]);
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
    const measure = () => {
      clearMeasurements();
      const element = scroller.current;
      if (element) setCell(charWidthFor(getComputedStyle(element).font));
    };
    document.fonts?.addEventListener("loadingdone", measure);
    let density: MediaQueryList | undefined;
    if (typeof matchMedia !== "function")
      return () => document.fonts?.removeEventListener("loadingdone", measure);
    const watchDensity = () => {
      density?.removeEventListener("change", changed);
      density = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      density.addEventListener("change", changed);
    };
    const changed = () => {
      measure();
      watchDensity();
    };
    watchDensity();
    return () => {
      document.fonts?.removeEventListener("loadingdone", measure);
      density?.removeEventListener("change", changed);
    };
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
    lines.forEach((text, offset) => {
      const rendered = element.querySelector<HTMLElement>(`[data-line-text="${first + offset}"]`);
      const width = isPlain(text)
        ? lineWidth(text, cell)
        : measureElement(rendered ?? element) || lineWidth(text, cell);
      widest = Math.max(widest, width);
    });
    const width = gutter + widest + paddingRight;
    setContent((previous) => {
      const base = previous.doc === doc ? previous.width : 0;
      const next = Math.max(base, width);
      if (previous.doc === doc && previous.width === next) return previous;
      return { doc, width: next };
    });
  }, [doc, lines, cell, gutter, first]);
  const contentWidth = content.doc === doc ? content.width : 0;
  const onOverflow = props.onHorizontalOverflow;

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      onOverflow?.(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [onOverflow, contentWidth, state.version]);

  const primary = state.selections[state.primary] ?? state.selections[0];
  const caretLine = primary?.head.line ?? 0;
  const caretColumn = primary?.head.column ?? 0;
  const selected = selectedLineSpan(state.selections);

  /** Screen readers get the current line, not an empty text box, while the caret moves. */
  const mirror = useCallback(() => {
    const element = field.current;
    if (!element || document.activeElement !== element || input.composingText !== undefined) return;
    const text = lineAt(caretLine);
    if (element.value !== text) element.value = text;
    const selection = state.selections[state.primary];
    const anchor = selection
      ? selection.anchor.line === caretLine
        ? selection.anchor.column
        : selection.anchor.line < caretLine
          ? 0
          : text.length
      : caretColumn;
    const from = Math.max(0, Math.min(anchor, caretColumn, text.length));
    const to = Math.max(0, Math.min(Math.max(anchor, caretColumn), text.length));
    element.setSelectionRange(from, to);
  }, [lineAt, caretLine, caretColumn, state.selections, state.primary, input.composingText]);

  useEffect(() => mirror(), [mirror, state.version]);

  const announce = (position: Position) =>
    setAnnouncement((previous) => ({
      text: `Line ${position.line + 1}, column ${position.column + 1}`,
      seq: (previous?.seq ?? 0) + 1,
    }));

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
    if (!props.line || props.line <= 0) return;
    const position = { line: props.line - 1, column: 0 };
    reveal(position);
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- a go-to-line is an explicit jump, announced once.
    announce(position);
  }, [props.line, reveal]);

  const hitLine = props.find?.hit?.line;
  const hitColumn = props.find?.hit?.column;
  useEffect(() => {
    if (hitLine === undefined || hitColumn === undefined) return;
    const position = { line: hitLine, column: hitColumn };
    reveal(position);
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- a find hit is an explicit jump, announced once.
    announce(position);
  }, [hitLine, hitColumn, reveal]);

  useEffect(() => {
    if (props.text === seenText.current) return;
    seenText.current = props.text;
    if (state.doc && state.doc.text() !== props.text) state.replaceText(props.text);
  }, [props.text, state]);

  const finder = useFindInFile({
    doc,
    version: state.version,
    select: (range) => state.select([{ anchor: range.start, head: range.end }]),
    reveal: (position) => {
      reveal(position);
      announce(position);
    },
    focusEditor: () => field.current?.focus({ preventScroll: true }),
  });
  const external = useFindResults(doc, state.version, {
    active: !finder.open && !!props.find?.query,
    query: finder.open ? "" : (props.find?.query ?? ""),
    caseSensitive: false,
  });
  const matches = finder.open ? finder.matches : external.matches;
  const activeQuery = finder.open ? finder.query : (props.find?.query ?? "");
  const externalIndex = useMemo(() => {
    const hit = props.find?.hit;
    if (!hit) return -1;
    return matches.findIndex(
      (range) => range.start.line === hit.line && range.start.column === hit.column,
    );
  }, [matches, props.find?.hit]);
  const currentIndex = finder.open ? finder.index : externalIndex;

  const navigationKeys = useEditorKeys({
    state,
    readOnly,
    path: props.path,
    rows: Math.max(1, Math.floor(height / lineHeight)),
    onFind: finder.openFind,
    ...(props.onSave ? { onSave: props.onSave } : {}),
    onEscape: () => {
      if (!finder.open) return false;
      finder.close();
      return true;
    },
    reveal,
  });

  const onKeyDown = (event: Parameters<typeof navigationKeys>[0]) => {
    // The mirrored line is for screen readers between keystrokes; a key starts from an empty box.
    if (field.current && !/^(Shift|Control|Alt|Meta)$/.test(event.key)) field.current.value = "";
    if (input.onKeyDown(event)) return;
    navigationKeys(event);
  };

  const byLine = useMemo(() => {
    const found = new Map<number, MatchSegment[]>();
    matches.forEach((range) => {
      if (range.end.line < first || range.start.line > last - 1) return;
      const currentMatch = matches[currentIndex] === range;
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
  }, [matches, first, last, currentIndex]);

  const [tokens, setTokens] = useState<Token[][]>([]);
  const tokenKey = `${paint}:${first}:${last}`;
  useEffect(() => {
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- colours live in the highlighter's own store, not in React.
    setTokens(state.highlighter?.tokens(first, last) ?? []);
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- first and last are already in the key.
  }, [tokenKey, state.highlighter]);

  const pointer = usePointerSelection({
    state,
    cell,
    gutter,
    element: host,
    focus: () => field.current?.focus({ preventScroll: true }),
    reveal,
  });

  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus({ preventScroll: true }),
    text: () => state.doc?.text() ?? props.text,
    selections: () => state.doc?.selections() ?? [],
    setSelections: (selections: readonly Selection[]) => state.select(selections),
  }));

  const textareaLeft = gutter + visualColumn(lineAt(caretLine), caretColumn) * cell - scroll.left;
  const textareaTop = caretLine * lineHeight - scroll.top;

  if (state.failed)
    return (
      <div role="region" aria-label={props.label} className={cn("h-full min-h-0", props.className)}>
        <div role="alert" className="flex flex-col items-start gap-2 p-4 text-ui">
          <p className="text-muted-foreground">
            The editor couldn't start. The file itself is unchanged.
          </p>
          <Button size="sm" variant="secondary" onClick={state.retry}>
            Try again
          </Button>
        </div>
      </div>
    );

  return (
    <div
      role="region"
      aria-label={props.label}
      data-selected-lines={selected}
      className={cn(
        "relative h-full min-h-0 focus-within:shadow-[inset_0_0_0_2px_var(--focus,var(--ring))]",
        props.className,
      )}
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
          className="relative min-h-full min-w-full"
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
                input.composingText === undefined ? undefined : { text: input.composingText }
              }
            />
          </div>
        </div>
      </div>
      {doc ? (
        <textarea
          ref={field}
          aria-label={name}
          aria-multiline="true"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          readOnly={readOnly}
          onBlur={props.onBlur}
          onFocus={mirror}
          autoFocus={props.focusOnMount}
          onKeyDown={onKeyDown}
          onInput={input.onInput}
          onCopy={input.onCopy}
          onCut={input.onCut}
          onPaste={input.onPaste}
          onDrop={input.onDrop}
          onCompositionStart={input.onCompositionStart}
          onCompositionUpdate={input.onCompositionUpdate}
          onCompositionEnd={input.onCompositionEnd}
          className="absolute size-px resize-none overflow-hidden border-0 bg-transparent p-0 font-mono text-ui text-transparent caret-transparent outline-none"
          style={{ left: textareaLeft, top: textareaTop }}
        />
      ) : null}
      {announcement ? (
        <span key={announcement.seq} aria-live="polite" className="sr-only">
          {announcement.text}
        </span>
      ) : null}
      {finder.open ? (
        <EditorFindBar
          query={finder.query}
          count={finder.matches.length}
          index={finder.index}
          status={finder.status}
          regex={finder.regex}
          caseSensitive={finder.caseSensitive}
          wholeWord={finder.wholeWord}
          onQuery={finder.setQuery}
          onToggle={finder.toggle}
          onStep={finder.step}
          onClose={finder.close}
        />
      ) : null}
    </div>
  );
}
