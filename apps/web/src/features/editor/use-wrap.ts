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
 * An edit reaches the index through the sink this hook installs, synchronously, before React
 * renders the document the edit produced: no render may measure the new text through rows that
 * still describe the old one.
 *
 * Every operation that changes row counts can move the text under a still scroll position, so
 * the view's top is remembered just before it and put back with the new counts, in a layout
 * effect, once the new height is committed.
 */

/** Lines measured in one idle slice. */
const slice = 2_000;

/** What the wrap index needs to hear about an edit, around the moment the document changes. */
export interface WrapEdits {
  /** The view's top, read while the rows still describe the text before the edit. */
  before(): void;
  /** The edit's spans, applied before React renders the text it produced. */
  after(batch: EditBatch): void;
  /** The operation changed nothing: forget the position remembered for it. */
  discard(): void;
}

/** Installed by {@link useWrap}, called by the document around every edit it applies. */
export type WrapSink = RefObject<WrapEdits | undefined>;

export function useWrap(options: {
  doc: EditorDocument | undefined;
  wrap: boolean;
  /** Cells that fit in the text column, indent excluded. */
  columns: number;
  /** The document hands its edits here, synchronously, as it applies them. */
  appliedRef: WrapSink;
  /** The line range on screen, preferred when a width change re-wraps. */
  visible: RefObject<{ first: number; last: number }>;
  /** The view's top, read before a re-wrap and written back after it. */
  anchor: ScrollAnchor;
}): WrapIndex | undefined {
  const { doc, wrap, columns, appliedRef, visible, anchor } = options;
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

  // Every applied edit lands in the index before anything reads a row: the spans are applied,
  // the lines they touched are invalidated, and only then does React render the new document.
  useLayoutEffect(() => {
    if (!index) {
      appliedRef.current = undefined;
      return;
    }
    appliedRef.current = {
      before: remember,
      after: (batch) => {
        anchor.mapThrough(batch.replacements);
        index.apply([batch]);
        // oxlint-disable-next-line react-compiler/set-state-in-effect -- the index is an external store; a slice of rows changed under React.
        setRevision((value) => value + 1);
      },
      discard: () => anchor.discard(),
    };
    return () => {
      appliedRef.current = undefined;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the sink closes over the index, the anchor and the remembered top.
  }, [index, appliedRef, anchor]);

  // Whatever a width change left queued is measured in idle slices, one render per slice.
  useLayoutEffect(() => {
    if (!index || index.pending() === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect, react-compiler/set-state-in-effect -- the index is an external store; a queued slice changes the rows drawn under React.
    setRevision((value) => value + 1);
  }, [index, wrap, columns, visible]);

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

  // The counts cannot move the text under the reader: the remembered text goes back on top.
  useLayoutEffect(() => {
    if (index) anchor.restore(index);
  });

  return index;
}
