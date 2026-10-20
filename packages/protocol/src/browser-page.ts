import { z } from "zod";
import { ThreadId } from "./ids.ts";

/*
 * What a remote view needs from a page that is not in its pixels: the focused field (so a
 * phone opens its keyboard there), a native picker the page opened, the pointer's cursor shape
 * and a `title` tooltip. The daemon watches the page and sends a tab's whole page state again
 * whenever any part of it changes (`browser.page`); clients keep the latest per tab.
 */

const id = z.string().min(1).max(256);
const position = z.number().finite().min(-100_000).max(100_000);
const extent = z.number().finite().min(0).max(100_000);
/** A box in the tab's viewport, in the CSS pixels input coordinates use. */
export const BrowserPageRect = z.object({
  x: position,
  y: position,
  width: extent,
  height: extent,
});
export type BrowserPageRect = z.infer<typeof BrowserPageRect>;

/**
 * The page's focused element while it takes typed text. `type` is the input's type
 * (`text`, `email`, `password`, …), `textarea` or `contenteditable`; `caret` is the caret's own
 * box where the page can tell it. Absent while nothing editable has focus.
 */
export const BrowserPageFocus = z.object({
  type: z.string().min(1).max(32),
  rect: BrowserPageRect,
  caret: BrowserPageRect.optional(),
  /** The field's own `inputmode` and `enterkeyhint`, when it sets them. */
  inputMode: z.string().max(32).optional(),
  enterKeyHint: z.string().max(32).optional(),
});
export type BrowserPageFocus = z.infer<typeof BrowserPageFocus>;

export const browserPickerKinds = [
  "select",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "color",
] as const;
export const BrowserPickerKind = z.enum(browserPickerKinds);
export type BrowserPickerKind = z.infer<typeof BrowserPickerKind>;
export const BrowserPickerOption = z.object({
  value: z.string().max(4096),
  label: z.string().max(512),
  disabled: z.boolean().optional(),
  /** The `<optgroup>` label the option sits under. */
  group: z.string().max(512).optional(),
});
export type BrowserPickerOption = z.infer<typeof BrowserPickerOption>;
/**
 * A picker the page opened (a `<select>`, a date, time or colour input). The engine's own popup
 * is kept closed; the person picks in ace and the choice goes back as a `pick` input.
 */
export const BrowserPagePicker = z.object({
  pickerId: id,
  kind: BrowserPickerKind,
  rect: BrowserPageRect,
  /** The element's current value. */
  value: z.string().max(4096),
  /** A select's options, in order. */
  options: z.array(BrowserPickerOption).max(1000).optional(),
  /** A date, time or number-like input's bounds, as its attributes give them. */
  min: z.string().max(64).optional(),
  max: z.string().max(64).optional(),
  step: z.string().max(64).optional(),
});
export type BrowserPagePicker = z.infer<typeof BrowserPagePicker>;

/** A `title` tooltip after the pointer rests, at the pointer's position. */
export const BrowserPageTooltip = z.object({
  text: z.string().min(1).max(1024),
  x: position,
  y: position,
});
export type BrowserPageTooltip = z.infer<typeof BrowserPageTooltip>;

/** The CSS cursor keywords a page can show under the pointer. Anything else reads as `default`. */
export const browserCursors = [
  "default",
  "pointer",
  "text",
  "vertical-text",
  "crosshair",
  "move",
  "grab",
  "grabbing",
  "not-allowed",
  "no-drop",
  "wait",
  "progress",
  "help",
  "context-menu",
  "cell",
  "copy",
  "alias",
  "zoom-in",
  "zoom-out",
  "all-scroll",
  "col-resize",
  "row-resize",
  "n-resize",
  "e-resize",
  "s-resize",
  "w-resize",
  "ne-resize",
  "nw-resize",
  "se-resize",
  "sw-resize",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "none",
] as const;
/** One of `browserCursors` from this daemon; a client draws a name it doesn't know as `default`. */
export const BrowserCursor = z.string().min(1).max(32);
export type BrowserCursor = z.infer<typeof BrowserCursor>;

export const BrowserPageState = z.object({
  focus: BrowserPageFocus.optional(),
  picker: BrowserPagePicker.optional(),
  /** Absent: the default arrow. */
  cursor: BrowserCursor.optional(),
  tooltip: BrowserPageTooltip.optional(),
});
export type BrowserPageState = z.infer<typeof BrowserPageState>;

/** A tab's page state changed; sent to the thread's viewers, and to each on subscribe. */
export const BrowserPageMessage = z.object({
  type: z.literal("browser.page"),
  threadId: ThreadId,
  tabId: id,
  page: BrowserPageState,
});
export type BrowserPageMessage = z.infer<typeof BrowserPageMessage>;
