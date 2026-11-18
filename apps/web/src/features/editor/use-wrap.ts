import type { EditorDocument, LineEdit } from "@ace/editor";
import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { whenIdle } from "@/lib/idle.ts";
import { WrapIndex } from "./wrap-index.ts";

/*
 * The editor's visual rows as React state: the index over the open document, the lines on screen
 * measured first after a width change, and the rest of a re-wrap spread over idle slices so a
 * resize never blocks on a fifty-thousand-line file.
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
  /** Takes the lines the edits since the last call changed. */
  takeChanges(): readonly LineEdit[];
  /** The line range on screen, preferred when a width change re-wraps. */
  visible: RefObject<{ first: number; last: number }>;
}): WrapIndex | undefined {
  const { doc, wrap, columns, version, takeChanges, visible } = options;
  const index = useMemo(() => (doc ? new WrapIndex(doc) : undefined), [doc]);
  const [revision, setRevision] = useState(0);

  // A new width, or wrap turned on or off, measures the lines on screen now, the rest later.
  // This runs during the render that first sees the width, so the list never paints a height
  // from a count it has not measured; the same width changes nothing.
  if (index) index.setColumns(wrap ? columns : Infinity, visible.current);

  // Whatever a width change left queued is measured in idle slices, one render per slice.
  useLayoutEffect(() => {
    if (!index || index.pending() === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect, react-compiler/set-state-in-effect -- the index is an external store; a queued slice changes the rows drawn under React.
    setRevision((value) => value + 1);
  }, [index, wrap, columns, visible]);

  // An edit re-measures only the lines its spans touched.
  useLayoutEffect(() => {
    if (!index || !doc) return;
    const spans = takeChanges();
    if (spans.length === 0) return;
    index.apply(spans, doc.lenLines());
    // oxlint-disable-next-line react/set-state-in-effect, react-compiler/set-state-in-effect -- an edit changes the document's rows, an external store.
    setRevision((value) => value + 1);
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- version is the edit's identity; the spans are taken from it.
  }, [index, doc, version, takeChanges]);

  // The rest of a whole-file re-wrap, one slice per idle period.
  useEffect(() => {
    if (!index || index.columns === Infinity || index.pending() === 0) return;
    return whenIdle(() => {
      index.pump(slice);
      setRevision((value) => value + 1);
    }, 16);
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- revision re-runs this after each slice of the same re-wrap.
  }, [index, columns, revision]);

  return index;
}
