// oxlint-disable react/no-array-index-key -- a line's row key is its number; there is no other identity.
// oxlint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the hidden textarea takes the keyboard; the scroller handles mouse selection.
import type { Position, Selection } from "@ace/editor";
import { pathParts } from "@ace/ui-core";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { EditorFindBar } from "./find-bar.tsx";
import { segmentsByLine } from "./find-matches.ts";
import { gutterWidth, lineHeight, visualColumn } from "./geometry.ts";
import { useEditorKeys } from "./keys.ts";
import type { Token } from "./highlighter.ts";
import { CaretLayers } from "./layers.tsx";
import { EditorLine } from "./line.tsx";
import { usePointerSelection } from "./pointer.ts";
import { useEditorDocument } from "./use-editor.ts";
import { selectedLineSpan } from "./cursor.ts";
import { useEditorInput } from "./use-editor-input.ts";
import { useEditorMetrics, useMirrorLine } from "./use-editor-metrics.ts";
import { useFindInFile } from "./use-find-in-file.ts";
import { useFindResults } from "./use-find.ts";
import type { CodeEditorProps } from "./types.ts";

const overscan = 8;
/** Files up to this many lines mount every row, as the Files viewer always has. */
const mountAll = 400;
const paddingRight = 24;
const noLines = [""];

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

  useEffect(() => {
    const highlighter = state.highlighter;
    if (!highlighter || !doc) return;
    const stop = highlighter.subscribe(() => setPaint((value) => value + 1));
    // After subscribing, so the first pass cannot finish before anyone listens.
    highlighter.setText(doc.text());
    return stop;
  }, [state.highlighter, doc]);

  const { cell, contentWidth } = useEditorMetrics({
    scroller,
    host,
    doc,
    lines,
    first,
    gutter,
    onOverflow: props.onHorizontalOverflow,
  });

  const primary = state.selections[state.primary] ?? state.selections[0];
  const caretLine = primary?.head.line ?? 0;
  const caretColumn = primary?.head.column ?? 0;
  const selected = selectedLineSpan(state.selections);

  const mirror = useMirrorLine({
    field,
    lineAt,
    caretLine,
    caretColumn,
    selections: state.selections,
    primary: state.primary,
    composing: input.composingText !== undefined,
    version: state.version,
  });

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

  const byLine = useMemo(
    () => segmentsByLine(matches, first, last - 1, currentIndex),
    [matches, first, last, currentIndex],
  );

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
