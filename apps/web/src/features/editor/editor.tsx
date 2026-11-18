// oxlint-disable react/no-array-index-key -- a row's key is its line and position; there is no other identity.
// oxlint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the hidden textarea takes the keyboard; the scroller handles mouse selection.
import type { Selection } from "@ace/editor";
import { pathParts } from "@ace/ui-core";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { isBefore, noAffinity, type Affinity } from "./affinity.ts";
import { EditorFindBar } from "./find-bar.tsx";
import { segmentsByLine, segmentsOnRow } from "./find-matches.ts";
import { gutterWidth, leastRowCells, lineHeight, longLine } from "./geometry.ts";
import { useEditorKeys } from "./keys.ts";
import type { Token } from "./highlighter.ts";
import { CaretLayers } from "./layers.tsx";
import { EditorLine, sliceTokens } from "./line.tsx";
import { usePointerSelection } from "./pointer.ts";
import { useEditorDocument } from "./use-editor.ts";
import { selectedLineSpan } from "./cursor.ts";
import { useEditorInput } from "./use-editor-input.ts";
import { useCellWidth, useEditorWidth, useMirrorLine } from "./use-editor-metrics.ts";
import { useAnnouncement, useReveal, useRevealJump } from "./use-reveal.ts";
import { useEditorFind } from "./use-editor-find.ts";
import { editorWindow } from "./row-window.ts";
import { ScrollAnchor } from "./use-anchor.ts";
import { useVisibleLines } from "./use-visible-lines.ts";
import { useWrap, type WrapEdits } from "./use-wrap.ts";
import { wholeLineRow } from "./wrap.ts";
import type { CodeEditorProps } from "./types.ts";

const paddingRight = 24;

/**
 * The Files tab's text editor: virtualized visual rows with a sticky line-number gutter,
 * selections and carets drawn over them, and one hidden textarea taking every input. The text
 * core, its cursors, undo and find are the Rust document in `@ace/editor`; the wrap layout turns
 * logical lines into the rows they draw, so the list, the carets, the pointer and the keys all
 * work in rows. This file is the surface.
 */
export function CodeEditor({ ref, ...props }: CodeEditorProps) {
  // Kept out of the compiler: the wrap index's row counts change without the index object
  // changing, so a memoized read of its rows would keep a height the file has outgrown.
  "use no memo";
  const readOnly = props.readOnly ?? false;
  const wrap = props.wrap ?? false;
  /** The wrap index hears each edit as the document applies it, before React renders it. */
  const appliedRef = useRef<WrapEdits | undefined>(undefined);
  /** Each caret's side of a hard break, as VS Code keeps it; secondary carets keep their own. */
  const [affinity, setAffinity] = useState<Affinity>(noAffinity);
  const state = useEditorDocument({
    text: props.text,
    path: props.path,
    original: props.marks ? undefined : props.text,
    editable: !readOnly,
    onBeforeEdit: () => appliedRef.current?.before(),
    onApplied: (batch) => {
      appliedRef.current?.after(batch);
      // An edit or an undo replaces the document's selections: a side measured against the old
      // carets means nothing once their positions and order have changed.
      setAffinity(noAffinity);
    },
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
  const viewport = useElementSize(scroller);
  const input = useEditorInput(state, readOnly, field);

  const name = pathParts(props.path).name;
  const lineCount = doc?.lenLines() ?? 0;
  const height = Math.max(120, viewport.height);
  const gutter = gutterWidth(lineCount);
  const cell = useCellWidth(scroller);
  const columns = Math.max(
    leastRowCells,
    Math.floor((viewport.width - gutter - paddingRight) / cell),
  );
  const visible = useRef({ first: 0, last: 200 });
  const anchor = useMemo(() => new ScrollAnchor(scroller, setScroll), [scroller, setScroll]);
  const layout = useWrap({
    doc,
    wrap,
    columns,
    appliedRef,
    visible,
    anchor,
  });

  const view = editorWindow({ layout, lineCount, scrollTop: scroll.top, height });
  const { rows, firstRow, lastRow } = view;
  const first = view.firstLine;
  const last = view.lastLine;
  // The wrap index prefers the lines on screen when a width change re-wraps the file.
  useLayoutEffect(() => {
    if (doc) visible.current = { first, last };
  });

  const { lines, lineAt } = useVisibleLines({ doc, version: state.version, first, last });

  const { contentWidth } = useEditorWidth({
    scroller,
    host,
    doc,
    lines,
    first,
    cell,
    gutter,
    wrap,
    onOverflow: props.onHorizontalOverflow,
  });

  useEffect(() => {
    const highlighter = state.highlighter;
    if (!highlighter || !doc) return;
    const stop = highlighter.subscribe(() => setPaint((value) => value + 1));
    // After subscribing, so the first pass cannot finish before anyone listens.
    highlighter.setText(doc.text());
    return stop;
  }, [state.highlighter, doc]);

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

  const { announcement, announce } = useAnnouncement();

  const { caretBox, reveal } = useReveal({
    doc: state.doc,
    layout,
    scroller,
    gutter,
    cell,
    wrap,
    viewport,
    onScroll: setScroll,
  });

  useRevealJump({ line: props.line, hit: props.find?.hit, reveal, announce });

  useEffect(() => {
    if (props.text === seenText.current) return;
    seenText.current = props.text;
    if (state.doc && state.doc.text() !== props.text) state.replaceText(props.text);
  }, [props.text, state]);

  const {
    finder,
    matches,
    query: activeQuery,
    current: currentIndex,
  } = useEditorFind({
    doc,
    version: state.version,
    find: props.find,
    select: (range) => {
      setAffinity(noAffinity);
      state.select([{ anchor: range.start, head: range.end }]);
    },
    reveal: (position) => {
      // A find hit starts afresh: its caret has no side of a hard break yet.
      reveal(position, false);
      announce(position);
    },
    focusEditor: () => field.current?.focus({ preventScroll: true }),
  });

  const navigationKeys = useEditorKeys({
    state,
    readOnly,
    path: props.path,
    rows: Math.max(1, Math.floor(height / lineHeight)),
    layout,
    affinity,
    onBefore: setAffinity,
    onFind: finder.openFind,
    ...(props.onSave ? { onSave: props.onSave } : {}),
    ...(props.onToggleWrap ? { onToggleWrap: props.onToggleWrap } : {}),
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
    layout,
    element: host,
    focus: () => field.current?.focus({ preventScroll: true }),
    reveal,
    affinity,
    onBefore: setAffinity,
  });

  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus({ preventScroll: true }),
    text: () => state.doc?.text() ?? props.text,
    version: () => state.doc?.version() ?? 0,
    selections: () => state.doc?.selections() ?? [],
    setSelections: (selections: readonly Selection[]) => {
      setAffinity(noAffinity);
      state.select(selections);
    },
  }));

  const caret = caretBox(
    { line: caretLine, column: caretColumn },
    isBefore(affinity, state.primary),
  );
  const textareaLeft = caret.left - scroll.left;
  const textareaTop = caret.top - scroll.top;

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
          style={{ height: rows * lineHeight, width: contentWidth || "100%" }}
        >
          <div aria-hidden>
            {lines.map((text, offset) => {
              const line = first + offset;
              const lineRows = layout?.rowsOf(line) ?? wholeLineRow;
              const startRow = layout?.startOf(line) ?? line;
              const long = text.length > longLine;
              const lineTokens = tokens[offset];
              const lineMatches = activeQuery ? byLine.get(line) : undefined;
              // A line can be a megabyte long: only the rows inside the window are built, and a
              // row outside it is never sliced, coloured or given a find match.
              const from = Math.max(0, firstRow - startRow);
              const to = Math.min(lineRows.length, lastRow - startRow);
              const drawn = [];
              for (let at = from; at < to; at++) {
                const row = lineRows[at];
                if (!row) continue;
                const index = startRow + at;
                const end = Math.min(row.end, text.length);
                drawn.push(
                  <EditorLine
                    key={`${line}:${at}`}
                    line={line}
                    row={index}
                    text={text.slice(row.start, end)}
                    number={at === 0 ? line + 1 : undefined}
                    indent={row.indent * cell}
                    tokens={
                      lineTokens && !long
                        ? wrap
                          ? sliceTokens(lineTokens, row.start, end)
                          : lineTokens
                        : undefined
                    }
                    gutter={gutter}
                    top={index * lineHeight}
                    mark={at === 0 ? (props.marks ?? state.marks)?.get(line + 1) : undefined}
                    current={line === caretLine}
                    matches={lineMatches ? segmentsOnRow(lineMatches, row.start, end) : undefined}
                    query={activeQuery}
                    long={long}
                    clip={!wrap}
                  />,
                );
              }
              return drawn;
            })}
            <CaretLayers
              selections={state.selections}
              lines={lineAt}
              layout={layout}
              firstLine={first}
              lastLine={last - 1}
              firstRow={firstRow}
              lastRow={lastRow}
              gutter={gutter}
              cell={cell}
              affinity={affinity}
              primary={state.primary}
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
