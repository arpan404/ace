import { Suspense, useCallback, useEffect, useId, useState, type ComponentProps } from "react";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import type { ThreadHoverContent as Content } from "./thread-hover-card.tsx";
import { onScrollMove, scrolledRecently } from "./scroll-rest.ts";

/**
 * The details card's code, out of the first paint: it shows only after the pointer has settled
 * on a row, so it loads once the browser is idle, or as the first card opens.
 */
// Pure: the home barrel re-exports this module, and a call the bundler must keep would hold it,
// and through it everything it imports, in the first paint's chunk.
const DeferredContent = /* @__PURE__ */ deferredComponent(() =>
  import("./thread-hover-card.tsx").then((module) => module.ThreadHoverContent),
);
const warm = () => void DeferredContent.preload().catch(() => {});
let warming = false;
/** Warms the card's code once per page, whichever row mounts first. */
function warmWhenIdle() {
  if (warming) return;
  warming = true;
  whenIdle(warm, 4_000);
}

/** A thread's details card, drawn inside its `HoverCard` while open. */
export function ThreadHoverCardContent(props: ComponentProps<typeof Content>) {
  return (
    <LocalBoundary label="the details card" fallback={null}>
      <Suspense fallback={null}>
        <DeferredContent.Component {...props} />
      </Suspense>
    </LocalBoundary>
  );
}

// Only an open preview retains a callback. Closing or unmounting releases it; ordinary row
// renders never subscribe to a global event or fan updates out to the rest of the sidebar.
const active = /* @__PURE__ */ new WeakMap<Document, { id: string; close(): void }>();
export function useThreadHover() {
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(warmWhenIdle, []);
  const change = useCallback(
    (next: boolean) => {
      // Rows sliding under a still pointer while the list scrolls never pop their cards.
      if (next && scrolledRecently(document)) return;
      if (next) warm();
      const previous = active.get(document);
      if (next) {
        if (previous?.id !== id) previous?.close();
        active.set(document, { id, close: () => setOpen(false) });
      } else if (previous?.id === id) active.delete(document);
      setOpen(next);
    },
    [id],
  );
  useEffect(
    () => () => {
      if (active.get(document)?.id === id) active.delete(document);
    },
    [id],
  );
  // An open card closes as soon as the page scrolls; a closed one listens for nothing.
  useEffect(() => (open ? onScrollMove(document, () => change(false)) : undefined), [open, change]);
  return { open, change };
}
