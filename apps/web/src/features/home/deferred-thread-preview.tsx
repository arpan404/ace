import { Suspense, type ReactElement } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** The details card on hover (`thread-hover-preview.tsx`), off the app's first paint. */
const DeferredPreview = deferredComponent(() =>
  import("./thread-hover-preview.tsx").then((module) => module.ThreadHoverPreview),
);

/**
 * The thread details card for a thread a transcript names, as the app supplies it
 * (`ThreadPreviewProvider`). Only a thread page draws one, so its code loads with the first such
 * row; the row shows alone meanwhile, and its card opens only after the pointer settles anyway.
 */
export function ThreadHoverPreview(props: { threadId: string; children?: ReactElement }) {
  if (!props.children) return null;
  return (
    <Suspense fallback={props.children}>
      <DeferredPreview.Component threadId={props.threadId}>
        {props.children}
      </DeferredPreview.Component>
    </Suspense>
  );
}
