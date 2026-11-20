// oxlint-disable react/no-array-index-key -- a row's key is its line and position; there is no other identity.
// oxlint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the hidden textarea takes the keyboard; the scroller handles mouse selection.
import type { Selection } from "@ace/editor";
import { fileLanguage, pathParts } from "@ace/ui-core";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { isBefore, noAffinity, type Affinity } from "./affinity.ts";
import { Decorations } from "./decorations.tsx";
import { EditorFindBar } from "./find-bar.tsx";
import { EditorStatusLine } from "./status-line.tsx";
import { useEditorStatus } from "./use-editor-status.ts";
import { GoToLineBar } from "./go-to-line.tsx";
import { segmentsByLine, segmentsOnRow } from "./find-matches.ts";
import {
  gutterWidth,
  leastRowCells,
  lineHeight as defaultLineHeight,
  longLine,
} from "./geometry.ts";
import { isMacPlatform, useEditorKeys } from "./keys.ts";
import type { Token } from "./highlighter.ts";
import { CaretLayers } from "./layers.tsx";
import { EditorLine, sliceTokens } from "./line.tsx";
import { usePointerSelection } from "./pointer.ts";
import { isFoldStart } from "./folding.ts";
import { StickyHeaders } from "./sticky-headers.tsx";
import { pinnedHeaders } from "./sticky.ts";
import { useFolding } from "./use-folding.ts";
import { useEditorDocument, type EditBatch } from "./use-editor.ts";
import { selectedLineSpan } from "./cursor.ts";
import { useEditorInput } from "./use-editor-input.ts";
import { useCellWidth, useEditorWidth, useMirrorLine } from "./use-editor-metrics.ts";
import { useAnnouncement, useReveal, useRevealJump } from "./use-reveal.ts";
import { useDecorations } from "./use-decorations.ts";
import { useEditorFind } from "./use-editor-find.ts";
import { editorWindow } from "./row-window.ts";
import { ScrollAnchor } from "./use-anchor.ts";
import { useVisibleLines } from "./use-visible-lines.ts";
import { useEditorLayer } from "./use-layer.ts";
import { useWrap, type WrapEdits } from "./use-wrap.ts";
import { wholeLineRow } from "./wrap.ts";
import type { CodeEditorProps } from "./types.ts";

const paddingRight = 24;
/** The gutter's right edge, where a line's fold control sits. */
const foldControl = 16;
/** Rulers are off unless the caller asks for them. */
const noRulers: readonly number[] = [];
const noLines: readonly number[] = [];

/** How long the first paint waits for colours before it shows plain text. */
const firstPaintHold = 250;

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
  /** Folds move with every edit, and open when it changes their hidden text. */
  const foldRef = useRef<((spans: EditBatch["spans"]) => void) | undefined>(undefined);
  /** Find in selection carries its scope through every edit. */
  const scopeRef = useRef<((replacements: EditBatch["replacements"]) => void) | undefined>(
    undefined,
  );
  /** A layer drawn over the text (annotations) carries its ranges through every edit. */
  const layerRef = useRef<((replacements: EditBatch["replacements"]) => void) | undefined>(
    undefined,
  );
  const replacedRef = useRef<((before: string, after: string) => void) | undefined>(undefined);
  /** Each caret's side of a hard break, as VS Code keeps it; secondary carets keep their own. */
  const [affinity, setAffinity] = useState<Affinity>(noAffinity);
  /** A language picked in the status line: a name, null for plain text, undefined the file's. */
  const [chosenLanguage, setChosenLanguage] = useState<string | null | undefined>(undefined);
  const language =
    chosenLanguage === undefined ? fileLanguage(props.path) : (chosenLanguage ?? undefined);
  // The caller's default (a setting) wins whenever it changes; the status line can flip it between.
  const [whitespace, setWhitespace] = useState(props.renderWhitespace ?? false);
  const [whitespaceDefault, setWhitespaceDefault] = useState(props.renderWhitespace);
  if (props.renderWhitespace !== whitespaceDefault) {
    setWhitespaceDefault(props.renderWhitespace);
    setWhitespace(props.renderWhitespace ?? false);
  }
  const lineHeight = props.lineHeight ?? defaultLineHeight;
  const fontSize = props.fontSize;
  const fontFamily = props.fontFamily?.trim() ? props.fontFamily : undefined;
  const state = useEditorDocument({
    language: chosenLanguage,
    text: props.text,
    shared: props.document,
    path: props.path,
    original: props.marks ? undefined : props.text,
    editable: !readOnly,
    onBeforeEdit: () => appliedRef.current?.before(),
    onNoEdit: () => appliedRef.current?.discard(),
    onApplied: (batch) => {
      appliedRef.current?.after(batch);
      scopeRef.current?.(batch.replacements);
      layerRef.current?.(batch.replacements);
      foldRef.current?.(batch.spans);
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
  const [goingTo, setGoingTo] = useState(false);
  const [paint, setPaint] = useState(0);
  // A file with a grammar is first drawn with its colours: the plain text it would show while
  // markit's worker loads is held (kept in layout, not shown) until the first colours arrive,
  // or briefly after, so a slow or large file is never kept blank. Later changes keep the
  // colours they had.
  const [shown, setShown] = useState(false);
  const held = !shown && language !== undefined;
  useEffect(() => {
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- the highlighter's first colours arrive outside React.
    if (paint > 0) setShown(true);
  }, [paint]);
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setShown(true), firstPaintHold);
    return () => clearTimeout(timer);
  }, [held]);
  const viewport = useElementSize(scroller);
  const input = useEditorInput(state, readOnly, field);

  const name = pathParts(props.path).name;
  const lineCount = doc?.lenLines() ?? 0;
  const height = Math.max(120, viewport.height);
  const gutter = gutterWidth(lineCount) + (props.layer?.margin ?? 0);
  const cell = useCellWidth(scroller, `${fontSize ?? ""}/${fontFamily ?? ""}`);
  const columns = Math.max(
    leastRowCells,
    Math.floor((viewport.width - gutter - paddingRight) / cell),
  );
  const visible = useRef({ first: 0, last: 200 });
  const anchor = useMemo(() => new ScrollAnchor(scroller, setScroll), [scroller, setScroll]);
  useLayoutEffect(() => anchor.setLineHeight(lineHeight), [anchor, lineHeight]);
  const layout = useWrap({
    doc,
    wrap,
    columns,
    appliedRef,
    visible,
    anchor,
  });

  const indentSize = doc?.indent().size ?? 2;
  const folding = useFolding({
    doc,
    layout,
    indentSize,
    select: (selections) => {
      setAffinity(noAffinity);
      state.select(selections);
    },
  });
  useLayoutEffect(() => {
    foldRef.current = folding.mapThrough;
  });

  const view = editorWindow({ layout, lineCount, scrollTop: scroll.top, height, lineHeight });
  const { rows, firstRow, lastRow } = view;
  const first = view.firstLine;
  const last = view.lastLine;
  // The wrap index prefers the lines on screen when a width change re-wraps the file.
  useLayoutEffect(() => {
    if (doc) visible.current = { first, last };
  });

  const { lines, lineAt } = useVisibleLines({ doc, version: state.version, first, last });

  // Sticky scroll: the headers of the blocks around the top line, re-read only when the top row,
  // the text or the view's height changes, and never more than a bounded number of lines.
  const stickyScroll = props.stickyScroll ?? true;
  const topRow = Math.floor(scroll.top / lineHeight);
  const viewRows = Math.floor(height / lineHeight);
  const pinned = useMemo(
    () =>
      stickyScroll && doc && layout && lineCount > 0
        ? pinnedHeaders({
            lineAt: (line) => doc.line(line),
            lineCount,
            lineOfRow: (row) => layout.lineAt(row),
            topRow,
            viewRows,
            indentSize,
          })
        : noLines,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the document's text changes with its version, not its identity.
    [stickyScroll, doc, layout, lineCount, topRow, viewRows, indentSize, state.version],
  );

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
    lineHeight,
    wrap,
    viewport,
    onScroll: setScroll,
  });

  useRevealJump({
    line: props.line,
    column: props.column,
    hit: props.find?.hit,
    reveal,
    announce,
  });

  const shared = props.document;
  useEffect(() => {
    // A shared document's text is its owner's; `text` is then only the gutter's base.
    if (shared || props.text === seenText.current) return;
    seenText.current = props.text;
    const before = state.doc?.text();
    if (before === undefined || before === props.text) return;
    state.replaceText(props.text);
    replacedRef.current?.(before, props.text);
  }, [shared, props.text, state]);

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
    edit: state.edit,
    focusEditor: () => field.current?.focus({ preventScroll: true }),
  });
  useLayoutEffect(() => {
    scopeRef.current = finder.mapScope;
  });

  const navigationKeys = useEditorKeys({
    state,
    readOnly,
    path: props.path,
    language: chosenLanguage,
    rows: Math.max(1, Math.floor(height / lineHeight)),
    layout,
    affinity,
    onBefore: setAffinity,
    onFind: finder.openFind,
    onFindAgain: finder.findAgain,
    onGoToLine: () => setGoingTo(true),
    onFold: (kind) => {
      if (kind === "fold") folding.foldAtCarets();
      else folding.unfoldAtCarets();
    },
    onChord: (event) => {
      const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
      if (mod && event.code === "Digit0") folding.foldAll();
      else if (mod && event.code === "KeyJ") folding.unfoldAll();
      else return false;
      return true;
    },
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
    if (props.layer?.onKey?.(event, layer.view)) return;
    if (input.onKeyDown(event)) return;
    navigationKeys(event);
  };

  const decorations = useDecorations({
    doc,
    version: state.version,
    selections: state.selections,
    primary: state.primary,
    lineAt,
    first,
    last,
    indentSize,
  });

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

  const layer = useEditorLayer({
    layer: props.layer,
    state,
    layout,
    lineAt,
    firstLine: first,
    lastLine: last - 1,
    firstRow,
    lastRow,
    gutter,
    cell,
    lineHeight,
    readOnly,
    host,
    select: (selections) => {
      setAffinity(noAffinity);
      state.select(selections);
    },
    focus: () => field.current?.focus({ preventScroll: true }),
  });
  useLayoutEffect(() => {
    layerRef.current = layer.edited;
    replacedRef.current = layer.replaced;
  });

  const pointer = usePointerSelection({
    onGutter: (line, at) => {
      // A layer takes presses on the line number; the fold control keeps the gutter's right edge.
      if (at.x < gutter - foldControl && props.layer?.onGutter?.(line, at.shiftKey, layer.view))
        return true;
      if (!folding.isFolded(line) && !folding.isFoldable(line)) return false;
      folding.toggle(line);
      return true;
    },
    state,
    cell,
    lineHeight,
    gutter,
    layout,
    element: host,
    focus: () => field.current?.focus({ preventScroll: true }),
    reveal,
    affinity,
    onBefore: setAffinity,
  });

  const editorStatus = useEditorStatus({
    state,
    readOnly,
    language,
    languageChosen: chosenLanguage !== undefined,
    setChosenLanguage,
    whitespace,
    setWhitespace,
    onStatus: props.onStatus,
  });

  useImperativeHandle(ref, () => ({
    status: () => editorStatus.status,
    statusActions: () => editorStatus.actions,
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
      className={cn("flex h-full min-h-0 flex-col", props.className)}
    >
      {finder.open ? <EditorFindBar finder={finder} mac={isMacPlatform()} /> : null}
      {goingTo && doc ? (
        <GoToLineBar
          lineCount={lineCount}
          lineLength={(line) => doc.line(line).length}
          onGo={(position) => {
            setGoingTo(false);
            setAffinity(noAffinity);
            state.select([{ anchor: position, head: position }]);
            reveal(position, false);
            announce(position);
            field.current?.focus({ preventScroll: true });
          }}
          onClose={() => {
            setGoingTo(false);
            field.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      <div
        data-editor-frame
        className="group/editor relative min-h-0 flex-1 font-mono text-ui focus-within:shadow-[inset_0_0_0_2px_var(--focus,var(--ring))]"
        style={{
          ...(fontSize === undefined ? {} : { fontSize }),
          ...(fontFamily === undefined ? {} : { fontFamily }),
        }}
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
          onContextMenu={(event) => {
            if (props.layer?.onContextMenu?.(event, layer.view)) event.preventDefault();
          }}
        >
          <div
            ref={host}
            data-highlight-pending={held || undefined}
            className={cn("relative min-h-full min-w-full", held && "opacity-0")}
            style={{ height: rows * lineHeight, width: contentWidth || "100%" }}
          >
            <div aria-hidden>
              <Decorations
                lines={lineAt}
                layout={layout}
                firstLine={first}
                lastLine={last - 1}
                firstRow={firstRow}
                lastRow={lastRow}
                gutter={gutter}
                cell={cell}
                lineHeight={lineHeight}
                indentGuides={props.indentGuides ?? true}
                guides={decorations.guides}
                indentSize={indentSize}
                brackets={decorations.brackets}
                occurrences={decorations.occurrences}
                whitespace={whitespace}
                rulers={props.rulers ?? noRulers}
              />
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
                  const row = lineRows.at(at);
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
                      lineHeight={lineHeight}
                      mark={at === 0 ? (props.marks ?? state.marks)?.get(line + 1) : undefined}
                      current={line === caretLine}
                      fold={
                        at !== 0
                          ? undefined
                          : folding.isFolded(line)
                            ? "closed"
                            : isFoldStart(lineAt, lineCount, line, indentSize)
                              ? "open"
                              : undefined
                      }
                      lastRow={at === lineRows.length - 1}
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
                lineHeight={lineHeight}
                blink={props.cursorBlinking}
                affinity={affinity}
                primary={state.primary}
                composing={
                  input.composingText === undefined ? undefined : { text: input.composingText }
                }
              />
            </div>
            {doc && props.layer ? props.layer.render(layer.view) : null}
          </div>
        </div>
        {doc ? (
          <StickyHeaders
            lines={pinned}
            lineAt={lineAt}
            gutter={gutter}
            lineHeight={lineHeight}
            scrollLeft={scroll.left}
            onPick={(line) => {
              const text = doc.line(line);
              const at = { line, column: text.length - text.trimStart().length };
              setAffinity(noAffinity);
              state.select([{ anchor: at, head: at }]);
              // The picked header lands just under the headers that still enclose it.
              const element = scroller.current;
              const outer = pinned.indexOf(line);
              if (element && layout) {
                element.scrollTop = Math.max(0, (layout.startOf(line) - outer) * lineHeight);
                setScroll({ top: element.scrollTop, left: element.scrollLeft });
              }
              announce(at);
              field.current?.focus({ preventScroll: true });
            }}
          />
        ) : null}
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
            className="absolute size-px resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent outline-none"
            style={{ left: textareaLeft, top: textareaTop }}
          />
        ) : null}
        {announcement ? (
          <span key={announcement.seq} aria-live="polite" className="sr-only">
            {announcement.text}
          </span>
        ) : null}
      </div>
      {editorStatus.status && props.statusLine !== false ? (
        <EditorStatusLine status={editorStatus.status} actions={editorStatus.actions} />
      ) : null}
    </div>
  );
}
