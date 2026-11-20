import { notYet } from "./stub.ts";
import type { EditorLayout } from "./types.ts";

/**
 * Read a stored layout leniently: bad parts drop, unknown fields stay, and anything unusable
 * becomes one empty group with this id.
 */
export function parseLayout(raw: unknown, fallbackGroupId: string): EditorLayout {
  return notYet(`parseLayout ${typeof raw} ${fallbackGroupId}`);
}
/** The layout as stored (spec 52): past the tab cap, the oldest unpinned saved tabs drop. */
export function storedLayout(layout: EditorLayout, unsaved: ReadonlySet<string>): EditorLayout {
  return notYet(`storedLayout ${unsaved.size}`);
}
