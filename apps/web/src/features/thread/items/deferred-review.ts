import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * Events and errors, loaded after first paint (warmed with the
 * thread's other deferred parts): most transcripts have few, so their parsers and views stay
 * off the route's budget.
 */

/** Dividers, delegation and task cards, error rows and notices (`event-divider.tsx`). */
export const DeferredEvent = deferredComponent(() =>
  import("./event-divider.tsx").then((module) => module.EventBlock),
);
/** A failed turn's ending (`failed-turn.tsx`): it draws the same error row as a notice. */
export const DeferredFailedTurn = deferredComponent(() =>
  import("../transcript/failed-turn.tsx").then((module) => module.FailedTurn),
);
/** Copy on a finished answer (IR-14): shown on hover, so it loads after first paint. */
export const DeferredCopyAnswer = deferredComponent(() =>
  import("./copy-answer.tsx").then((module) => module.CopyAnswer),
);
