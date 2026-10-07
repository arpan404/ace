import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * The cards attached to the thread's composer. Their code (and the request card's) loads after
 * the thread has painted, warmed while idle with `preloadDeferred`. Apart from the composer's
 * other deferred parts, which the transcript's rows import: the request card reaches back to
 * those rows.
 */

/** The agent's open requests, as the deck of cards attached to the composer. */
export const DeferredRequestStack = deferredComponent(() =>
  import("./request-stack.tsx").then((module) => module.RequestStack),
);
/** Where the thread runs, as a card attached to the composer, opened from its pill. */
export const DeferredThreadEnvironment = deferredComponent(() =>
  import("./thread-environment.tsx").then((module) => module.ThreadEnvironmentCard),
);

export function preloadComposerCards(): Promise<unknown> {
  return Promise.all([DeferredRequestStack.preload(), DeferredThreadEnvironment.preload()]);
}
