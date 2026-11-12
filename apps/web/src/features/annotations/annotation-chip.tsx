import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { annotationCount } from "./annotation-words.ts";
import { ChipFace, PendingTrigger } from "./chip-face.tsx";
import type { DraftAnnotationsState } from "./draft-annotations.ts";
import { useSessionPort } from "./store.ts";

/** The chip's list and its popover, off the thread route's first paint. */
const DeferredChipPopover = deferredComponent(() =>
  import("./annotation-popover.tsx").then((module) => module.AnnotationChipPopover),
);

/** Warms the chip's list so its first open draws at once. */
export const preloadAnnotationChip = DeferredChipPopover.preload;

/**
 * The draft's browser annotations as one chip above the message: its count opens a list of
 * them (crop, element, page text, comment) where each can be reopened in the page or removed;
 * its close button removes them all. Markers on the page follow. Until the list's code arrives
 * the same face stands in, so a draft restored with annotations shows its chip at once.
 */
export function AnnotationChip(props: {
  /** The thread whose browser holds the markers; none for a new thread's draft. */
  threadId: string | undefined;
  annotations: DraftAnnotationsState;
}) {
  const session = useSessionPort(props.threadId ?? "");
  const { annotations } = props;
  if (!annotations.count) return null;
  const label = annotationCount(annotations.count);
  const clear = () => {
    annotations.clear();
    session?.clear();
  };
  return (
    <div className="flex px-3 pt-3">
      <Suspense fallback={<ChipFace label={label} onClear={clear} trigger={PendingTrigger} />}>
        <DeferredChipPopover.Component
          threadId={props.threadId}
          annotations={annotations}
          session={session}
          label={label}
          onClear={clear}
        />
      </Suspense>
    </div>
  );
}
