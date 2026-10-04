import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * The card for a pending approval, question or plan, loaded after first paint. Its own module
 * so Deck can show an agent's request without pulling in the thread screen.
 */
export const DeferredInteractionCard = deferredComponent(() =>
  import("./interaction-card.tsx").then((module) => module.InteractionCard),
);

/** The card as a component other slices render (it suspends until its code arrives). */
export const DeferredThreadInteraction = DeferredInteractionCard.Component;
