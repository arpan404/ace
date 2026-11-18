import type { EditorDocument } from "@ace/editor";
import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { whenIdle } from "@/lib/idle.ts";
import type { ScrollAnchor } from "./use-anchor.ts";
import { WrapIndex } from "./wrap-index.ts";
import type { EditBatch } from "./use-editor.ts";

/*
 * The editor's visual rows as React state: the index over the open document, the lines on screen
 * measured first after a width change, and the rest of a re-wrap spread over idle slices so a
 * resize never blocks on a fifty-thousand-line file.
 *
 * Every operation that changes row counts can move the text under a still scroll position, so
 * the view's top line is remembered just before it and put back with the new counts, in a layout
 * effect, before the next paint.
 */

/** Lines measured in one idle slice. */
const slice = 2_000;

export function useWrap(options: {
  doc: EditorDocument | undefined;
  wrap: boolean;
  /** Cells that fit in the text column, indent excluded. */
  columns: number;
  /** Changes on every applied edit. */
  version: number;
  /** Takes the edits since the last call, one batch each. */
  takeChanges(): readonly EditBatch[];
  /** The line range on screen, preferred when a width change re-wraps. */
  visible: RefObject<{ first: number; last: number }>;
  /** The view's top line, read before a re-wrap and written back after it. */
  anchor: ScrollAnchor;
}): WrapIndex | undefined {
  const { doc, wrap, columns, version, takeChanges, visible, anchor } = options;
  const index = useMemo(() => (doc ? new WrapIndex(doc) : undefined), [doc]);
  const [revision, setRevision] = useState(0);
  const remember = () => {
    if (index) anchor.remember(index);
  };

  // A new width, or wrap turned on or off, measures the lines on screen now, the rest later.
  // This runs during the render that first sees the width, so the list never paints a height
  // from a count it has not measured; the same width changes nothing.
  if (index) {
    const next = wrap ? columns : Infinity;
    if (index.columns !== next) {
      remember();
      index.setColumns(next, visible.current);
    }
  }

  // Whatever a width change left queued is measured in idle slices, one render per slice.
  useLayoutEffect(() => {
    if (!index || index.pending() === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect, react-compiler/set-state-in-effect -- the index is an external store; a queued slice changes the rows drawn under React.
    setRevision((value) => value + 1);
  }, [index, wrap, columns, visible]);

  // An edit re-measures only the lines its spans touched, in each batch's own coordinates.
  useLayoutEffect(() => {
    if (!index || !doc) return;
    const batches = takeChanges();
    if (batches.length === 0) return;
    remember();
    index.apply(batches);
    // oxlint-disable-next-line react/set-state-in-effect, react-compiler/set-state-in-effect -- an edit changes the document's rows, an external store.
    setRevision((value) => value + 1);
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- version is the edit's identity; the batches are taken from it.
  }, [index, doc, version, takeChanges]);

  // The rest of a whole-file re-wrap, one slice per idle period.
  useEffect(() => {
    if (!index || index.columns === Infinity || index.pending() === 0) return;
    return whenIdle(() => {
      remember();
      index.pump(slice);
      setRevision((value) => value + 1);
    }, 16);
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- revision re-runs this after each slice of the same re-wrap.
  }, [index, columns, revision]);

  // The counts cannot move the text under the reader: the remembered line goes back on top.
  useLayoutEffect(() => {
    if (index) anchor.restore(index);
  });

  return index;
}
