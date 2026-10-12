import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * What the tab attached to the thread's composer shows. Its code (and the request card's) loads
 * before a thread with pending requests paints; the other tabs warm while idle. Apart from the
 * composer's other deferred parts, which the transcript's rows import: the request card reaches
 * back to those rows.
 */

/** The agent's open requests, as the deck of cards attached to the composer. */
export const DeferredRequestStack = deferredComponent(() =>
  import("./request-stack.tsx").then((module) => module.RequestStack),
);
export const DeferredEnvironmentStrip = deferredComponent(() =>
  import("./environment-strip.tsx").then((module) => module.EnvironmentStrip),
);
export function preloadComposerCards(): Promise<unknown> {
  return Promise.all([DeferredRequestStack.preload(), DeferredEnvironmentStrip.preload()]);
}
