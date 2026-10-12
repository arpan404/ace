import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * The composer's strip and what it shows. Its code (and the request card's) loads before a
 * thread with pending requests paints, and warms while idle otherwise. Apart from the composer's
 * other deferred parts, which the transcript's rows import: the request card reaches back to
 * those rows.
 */

/** The one strip above the composer: requests, connection, queue or plan. */
export const DeferredComposerStrip = deferredComponent(() =>
  import("./composer-strip.tsx").then((module) => module.ComposerStrip),
);
export function preloadComposerCards(): Promise<unknown> {
  return DeferredComposerStrip.preload();
}
