import { Suspense, type RefObject } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { layerBox } from "./layer-box.ts";

/** The selection listeners and the Reply pill: drawn only once words are selected. */
const DeferredQuoteOffer = deferredComponent(() =>
  import("./quote-offer.tsx").then((module) => module.QuoteOffer),
);

/**
 * Over the transcript, a Reply pill beside words selected in an agent's message. The layer is
 * empty and lets every press through until then, so its code loads just after the thread paints,
 * off the route's first paint (ADR 0056), with the same empty box in its place meanwhile.
 */
export function QuoteLayer(props: { threadId: string; viewport: RefObject<HTMLElement | null> }) {
  return (
    <Suspense fallback={<div className={layerBox} />}>
      <DeferredQuoteOffer.Component threadId={props.threadId} viewport={props.viewport} />
    </Suspense>
  );
}
