import { codeIntentComment, type CodeAnnotation } from "@ace/ui-core";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  onSide,
  useCodeAnnotations,
  useCodeEditorPort,
  type CodeAnnotationInput,
  type CodeAnnotationMove,
} from "@/features/annotations/index.ts";
import { excerptOf, mapSpan, reanchor, touches, verify, type Span } from "./annotate-anchor.ts";
import { AnnotationLayer, selectedSpan, type LayerActions, type Open } from "./annotate-layer.tsx";
import { isMacPlatform } from "./keys.ts";
import type { EditorLayer, EditorLayerView } from "./layer.ts";

export interface EditorAnnotationsOptions {
  /** The thread whose composer collects the annotations; none for a new thread's draft. */
  threadId: string | undefined;
  /** The file, relative to the project root, as the agent will read it. */
  path: string;
  /** The view shows one side of a diff; `old` is the file before the change. */
  side?: "old" | "new" | undefined;
  /** Ids for new annotations; tests pass their own. */
  newId?: (() => string) | undefined;
}

const randomId = () => crypto.randomUUID();

/**
 * The last edit each document's annotations were mapped through. Views of one shared document
 * (a file open in two Deck groups) all carry the layer; the edit moves the ranges once.
 */
const mappedThrough = new WeakMap<object, number>();

/** Whether this edit to the view's document still has to move the ranges (and note it has). */
function firstToMap(view: EditorLayerView): boolean {
  const revision = view.revision();
  if (!revision) return true;
  if (mappedThrough.get(revision.document) === revision.version) return false;
  mappedThrough.set(revision.document, revision.version);
  return true;
}
/** The gutter's strip left of the line numbers where the numbered markers sit. */
const annotationMargin = 20;

/** The line under `line` as a whole-line span: to the next line's start, or the last line's end. */
function lineSpan(view: EditorLayerView, from: number, to: number): Span {
  const end =
    to + 1 < view.lineCount
      ? { line: to + 1, column: 0 }
      : { line: to, column: view.line(to).length };
  return { start: { line: from, column: 0 }, end };
}

/** Once annotated, the selection gives way to a caret at its end, and the bar under it goes. */
function settle(view: EditorLayerView, span: Span) {
  view.select([{ anchor: span.end, head: span.end }]);
}

/** What a gesture annotates: the selection, else the caret's line. */
function targetSpan(view: EditorLayerView): Span {
  const selected = selectedSpan(view);
  if (selected) return selected;
  const caret = view.selections[view.primary]?.head.line ?? 0;
  return lineSpan(view, caret, caret);
}

/**
 * Code annotations for one editor (`CodeEditor`'s `layer`): select code, or press line numbers
 * (Shift to extend), then Annotate (⌘⇧A, the bar under the selection, or the context menu) or a
 * quick action; the comment opens beside the code and the annotation waits in the thread's
 * composer with the Browser's. Markers follow edits to the file and an agent's rewrite of it.
 * Undefined while the thread has no composer to collect them.
 */
export function useEditorAnnotations(options: EditorAnnotationsOptions): EditorLayer | undefined {
  const { threadId, path, side } = options;
  const { port, annotations } = useCodeAnnotations(threadId, path, side);
  const [open, setOpen] = useState<Open>();
  const gutterFrom = useRef<number | undefined>(undefined);
  const newId = options.newId ?? randomId;
  /** Annotations this editor has checked against the text it opened with, or made itself. */
  const checked = useRef(new Set<string>());
  const view = useRef<EditorLayerView | undefined>(undefined);

  useCodeEditorPort(threadId, path, side, (id) => setOpen({ kind: "edit", id }));

  const mine = (): readonly CodeAnnotation[] =>
    (port?.code() ?? []).filter((each) => each.path === path && onSide(each, side));

  // Stored annotations are checked once against the text this editor opened: an agent may have
  // rewritten the file while it was closed.
  const check = (current: EditorLayerView) => {
    const fresh = annotations.filter((each) => !checked.current.has(each.id));
    if (!port || !fresh.length) return;
    for (const each of fresh) checked.current.add(each.id);
    const lines = Array.from({ length: current.lineCount }, (_, index) => current.line(index));
    const text = lines.join("\n");
    port.moveCode(
      fresh.map((each) => {
        const found = verify(each, { text: each.excerpt, cut: each.cut }, lines, text);
        return { id: each.id, start: found.start, end: found.end, outdated: found.outdated };
      }),
    );
  };

  const latest = useRef({ open });
  useLayoutEffect(() => {
    latest.current = { open };
  });

  if (!port) return undefined;

  const actions: LayerActions = {
    annotate: (span, intent) => {
      // A question needs its words: Ask opens the comment with the question chosen.
      if (!intent || intent === "ask") {
        setOpen({ kind: "new", span, comment: "", ...(intent ? { intent } : {}) });
        return;
      }
      // Fix and Explain are annotations at once, with their words filled in and open to change.
      const id = newId();
      checked.current.add(id);
      const source = view.current;
      if (!source) return;
      port.saveCode({
        id,
        path,
        start: span.start,
        end: span.end,
        ...excerptOf(source.line, span),
        comment: codeIntentComment[intent],
        intent,
        ...(side === "old" ? { side } : {}),
      });
      settle(source, span);
      setOpen({ kind: "edit", id });
    },
    save: (target, comment, intent) => {
      const source = view.current;
      if (target.kind === "new" && source) {
        const id = newId();
        checked.current.add(id);
        port.saveCode({
          id,
          path,
          start: target.span.start,
          end: target.span.end,
          ...excerptOf(source.line, target.span),
          comment,
          ...(intent ? { intent } : {}),
          ...(side === "old" ? { side } : {}),
        });
        settle(source, target.span);
      } else if (target.kind === "edit") {
        const kept = mine().find((each) => each.id === target.id);
        if (kept) {
          const next: CodeAnnotationInput = { ...kept, comment };
          if (intent) next.intent = intent;
          else delete next.intent;
          port.saveCode(next);
        }
      }
      setOpen(undefined);
      source?.focus();
    },
    remove: (id) => {
      port.remove(id);
      setOpen(undefined);
      view.current?.focus();
    },
    close: () => {
      setOpen(undefined);
      view.current?.focus();
    },
    closeMenu: () => setOpen((now) => (now?.kind === "menu" ? undefined : now)),
    edit: (id) => setOpen({ kind: "edit", id }),
  };

  return {
    margin: annotationMargin,
    render: (current) => (
      <ViewKeeper view={current} intoRef={view} annotations={annotations} check={check}>
        <AnnotationLayer view={current} annotations={annotations} open={open} actions={actions} />
      </ViewKeeper>
    ),
    onEdit: (replacements, current) => {
      if (!firstToMap(current)) return;
      const moves: CodeAnnotationMove[] = [];
      for (const each of mine()) {
        const mapped = mapSpan(each, replacements);
        const outdated = each.outdated || mapped.outdated;
        // Text typed inside a range is part of it now: what the agent reads follows.
        const excerpt =
          !outdated && touches(each, replacements) ? excerptOf(current.line, mapped) : undefined;
        moves.push({ id: each.id, start: mapped.start, end: mapped.end, outdated, ...excerpt });
      }
      if (moves.length) port.moveCode(moves);
    },
    onReplace: (before, after) => {
      const list = mine();
      if (!list.length) return;
      const old = before.split("\n");
      const now = after.split("\n");
      port.moveCode(
        list.map((each) => {
          const found = reanchor(each, { text: each.excerpt, cut: each.cut }, old, now, after);
          return { id: each.id, start: found.start, end: found.end, outdated: found.outdated };
        }),
      );
    },
    onKey: (event, current) => {
      const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
      if (!mod || !event.shiftKey || event.altKey || event.code !== "KeyA") return false;
      event.preventDefault();
      event.stopPropagation();
      actions.annotate(targetSpan(current));
      return true;
    },
    onGutter: (line, extend, current) => {
      const from = extend && gutterFrom.current !== undefined ? gutterFrom.current : line;
      if (!extend) gutterFrom.current = line;
      const span = lineSpan(current, Math.min(from, line), Math.max(from, line));
      current.select([{ anchor: span.start, head: span.end }]);
      return true;
    },
    onContextMenu: (event, current) => {
      if (latest.current.open) return false;
      setOpen({ kind: "menu", span: targetSpan(current), x: event.clientX, y: event.clientY });
      return true;
    },
  };
}

/**
 * Keeps the latest view for handlers that run outside a render (saving, focusing), and checks
 * annotations this editor hasn't seen against its text once it has some.
 */
function ViewKeeper(props: {
  view: EditorLayerView;
  intoRef: { current: EditorLayerView | undefined };
  annotations: readonly CodeAnnotation[];
  check(view: EditorLayerView): void;
  children: ReactNode;
}) {
  const { view, intoRef, annotations } = props;
  useLayoutEffect(() => {
    intoRef.current = view;
  });
  const loaded = view.lineCount > 0;
  const latest = useRef(props.check);
  useLayoutEffect(() => {
    latest.current = props.check;
  });
  useEffect(() => {
    if (loaded) latest.current(intoRef.current ?? view);
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- checked when the list or the text's arrival changes, not every render.
  }, [annotations, loaded]);
  return props.children;
}
