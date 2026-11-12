import { Suspense, useId, useRef, useState } from "react";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { PendingDismiss } from "@/lib/pending-open.tsx";
import { annotationCount } from "./annotation-words.ts";
import { ChipFace } from "./chip-face.tsx";
import type { DraftAnnotationsState } from "./draft-annotations.ts";
import { useSessionPort } from "./store.ts";

/** The chip's list and its popover, off the thread route's first paint. */
const DeferredAnnotationList = deferredComponent(() =>
  import("./annotation-popover.tsx").then((module) => module.AnnotationList),
);

/** Warms the chip's list so its first open draws at once. */
export const preloadAnnotationChip = DeferredAnnotationList.preload;

/**
 * The draft's browser annotations as one chip above the message: its count opens a list of
 * them (crop, element, page text, comment) where each can be reopened in the page or removed;
 * its close button removes them all. Markers on the page follow.
 *
 * The chip itself is always here, so a draft restored with annotations shows it at once. Its
 * list loads on first open: a press made while it loads opens it when it arrives, unless Escape
 * or a press elsewhere cancelled it, and a list that fails to load stays inside the chip (closed,
 * tried again on the next press).
 */
export function AnnotationChip(props: {
  /** The thread whose browser holds the markers; none for a new thread's draft. */
  threadId: string | undefined;
  annotations: DraftAnnotationsState;
}) {
  const session = useSessionPort(props.threadId ?? "");
  const { annotations } = props;
  const button = useRef<HTMLButtonElement>(null);
  const popup = useId();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  // Without annotations the chip is gone, and its list with it: it comes back closed.
  if (!annotations.count && open) setOpen(false);
  if (open && !opened) setOpened(true);
  if (!annotations.count) return null;
  const label = annotationCount(annotations.count);
  const clear = () => {
    annotations.clear();
    session?.clear();
  };
  return (
    <div className="flex px-3 pt-3">
      <ChipFace
        label={label}
        button={button}
        open={open}
        popup={popup}
        onToggle={() => setOpen(!open)}
        onClear={clear}
      />
      {opened && (
        <LocalBoundary
          label="the annotations"
          fallback={null}
          onFailed={() => setOpen(false)}
          retryWhen={open}
        >
          <Suspense
            fallback={open && <PendingDismiss anchor={button} onDismiss={() => setOpen(false)} />}
          >
            <DeferredAnnotationList.Component
              threadId={props.threadId}
              annotations={annotations}
              session={session}
              open={open}
              onOpenChange={setOpen}
              anchor={button}
              popup={popup}
            />
          </Suspense>
        </LocalBoundary>
      )}
    </div>
  );
}
