/*
 * The steps of a screen_act batch. The source of truth for the helper's action set: the helper
 * parses leniently, so every cross-field rule is checked here, with errors the model can fix.
 */
import { z } from "zod";

const id = z.number().int().min(1).describe("Element id from the outline.");
const point = z.number().min(0).max(20_000);
const screenPoint = z.number().min(-20_000).max(20_000);
const size = z.number().int().min(1).max(20_000);
const modifiers = z
  .array(z.enum(["cmd", "shift", "alt", "ctrl", "fn"]))
  .min(1)
  .max(5)
  .optional()
  .describe('Keys held during the step, e.g. ["cmd"] for a ⌘-click.');
const holdMs = z
  .number()
  .int()
  .min(0)
  .max(5_000)
  .optional()
  .describe("Keep it pressed this long (long press).");

const when = z
  .strictObject({
    text: z.string().min(1).max(200).optional().describe("Text in an element's line."),
    id: id.optional(),
    gone: z.boolean().optional().describe("Run only if it is not there."),
  })
  .refine((value) => value.text !== undefined || value.id !== undefined, {
    message: "when needs text or id",
  })
  .optional()
  .describe("Run this step only if a matching element is there now; otherwise skip it.");

/** A step object: its fields plus the optional `when` guard every step accepts. */
const step = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape, when });

type Located = { id?: number | undefined; x?: number | undefined; y?: number | undefined };

/** At most one of id or x,y, and x with y. */
function pointRule(value: Located, context: z.RefinementCtx, what: string): void {
  const placed = value.x !== undefined || value.y !== undefined;
  if (placed && (value.x === undefined || value.y === undefined))
    context.addIssue({ code: "custom", message: `${what} needs both x and y` });
  else if (placed && value.id !== undefined)
    context.addIssue({ code: "custom", message: `${what} takes id or x,y, not both` });
}

/** Exactly one of id or x,y. */
function located(value: Located, context: z.RefinementCtx, what: string): void {
  pointRule(value, context, what);
  if (value.id === undefined && value.x === undefined && value.y === undefined)
    context.addIssue({ code: "custom", message: `${what} needs id or x,y` });
}

const endpoint = z
  .union([z.tuple([point, point]), z.strictObject({ id })])
  .describe("[x, y] screenshot pixels, or {id}.");

const windowOps = [
  "close",
  "minimize",
  "restore",
  "zoom",
  "fullscreen",
  "raise",
  "move",
  "resize",
] as const;

export const ComputerAction = z.discriminatedUnion("type", [
  step("click", {
    id: id.optional(),
    x: point.optional().describe("Screenshot pixel, when the element is not in the outline."),
    y: point.optional(),
    button: z
      .enum(["left", "right", "middle"])
      .optional()
      .describe("right opens the context menu."),
    count: z.number().int().min(1).max(3).optional().describe("2 for a double-click."),
    modifiers,
    hold_ms: holdMs,
  }).superRefine((value, context) => located(value, context, "click")),
  step("move", {
    id: id.optional(),
    x: point.optional(),
    y: point.optional(),
  })
    .describe("Hover: shows tooltips and hover menus.")
    .superRefine((value, context) => located(value, context, "move")),
  step("type", {
    text: z.string().min(1).max(5000),
    id: id.optional().describe("Focus this element first."),
  }),
  step("paste", {
    text: z.string().min(1).max(200_000),
    format: z
      .enum(["text", "markdown", "html"])
      .optional()
      .describe("markdown or html paste as rich text."),
    id: id.optional().describe("Focus this element first."),
  }),
  step("key", {
    key: z
      .string()
      .min(1)
      .max(64)
      .describe('A key or chord: "Return", "Escape", "Down", "cmd+n", "shift+Tab".'),
    repeat: z.number().int().min(1).max(50).optional(),
    hold_ms: holdMs,
    id: id.optional().describe("Focus this element first."),
  }),
  step("set_value", {
    id,
    value: z.union([z.string().max(100_000), z.number(), z.boolean()]),
  }),
  step("select_text", {
    id,
    text: z.string().min(1).max(2000).describe("Text exactly as the outline shows it."),
    prefix: z
      .string()
      .max(200)
      .optional()
      .describe("Text just before it, when it occurs more than once."),
    suffix: z.string().max(200).optional().describe("Text just after it."),
    cursor: z
      .enum(["before", "after"])
      .optional()
      .describe("Place the caret instead of selecting."),
  }),
  step("scroll", {
    id: id.optional(),
    x: point.optional(),
    y: point.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    pages: z.number().min(0.1).max(20).optional().describe("Default 1."),
    pixels: z.number().int().min(1).max(20_000).optional().describe("Instead of pages."),
  }).superRefine((value, context) => {
    pointRule(value, context, "scroll");
    if (value.pages !== undefined && value.pixels !== undefined)
      context.addIssue({ code: "custom", message: "scroll takes pages or pixels, not both" });
  }),
  step("scroll_to", { id }).describe("Scroll until the element is visible."),
  step("action", {
    id,
    name: z.string().min(1).max(80).describe("One of the element's listed Actions."),
  }),
  step("menu", {
    path: z.array(z.string().min(1).max(120)).min(1).max(8).describe('e.g. ["File", "Export…"].'),
  }),
  step("focus", { id }),
  step("drag", { from: endpoint, to: endpoint, modifiers, hold_ms: holdMs }),
  step("window", {
    op: z.enum(windowOps).describe("Acts on the current window."),
    x: screenPoint
      .optional()
      .describe("move: screen points from the top-left of the main display."),
    y: screenPoint.optional(),
    width: size.optional().describe("resize: in screen points."),
    height: size.optional(),
  }).superRefine((value, context) => {
    if (value.op === "move" && (value.x === undefined || value.y === undefined))
      context.addIssue({ code: "custom", message: "window move needs x and y" });
    if (value.op === "resize" && (value.width === undefined || value.height === undefined))
      context.addIssue({ code: "custom", message: "window resize needs width and height" });
  }),
  step("wait", { ms: z.number().int().min(0).max(10_000) }),
  step("wait_for", {
    text: z.string().min(1).max(200).optional().describe("Text in an element's line."),
    id: id.optional(),
    gone: z.boolean().optional().describe("Wait until it disappears instead."),
    timeout_ms: z.number().int().min(100).max(15_000).optional().describe("Default 5000."),
  }).superRefine((value, context) => {
    if (value.text === undefined && value.id === undefined)
      context.addIssue({ code: "custom", message: "wait_for needs text or id" });
  }),
  step("activate", {}),
]);
export type ComputerAction = z.infer<typeof ComputerAction>;
