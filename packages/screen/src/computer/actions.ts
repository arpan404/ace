/*
 * The steps of a screen_act batch. The source of truth for the helper's action set: the helper
 * parses leniently, so every cross-field rule is checked here, with errors the model can fix.
 *
 * The model reads one flat step object (`AdvertisedStep`): each field once, and a one-line
 * grammar on `type` saying which fields each step takes. That costs about a third of a union
 * of nineteen step objects on every request. Each call is then checked against the strict
 * union (`StrictStep`), so a field the step does not take is still an error naming it.
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

/** A step object: its type and fields. */
const step = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape });

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

const StrictStep = z.discriminatedUnion("type", [
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
  step("if", {
    text: z.string().min(1).max(200).optional().describe("Text in an element's line."),
    id: id.optional(),
    gone: z.boolean().optional().describe("True: run them only if it is not there."),
    steps: z
      .number()
      .int()
      .min(1)
      .max(19)
      .optional()
      .describe("How many steps it guards; default 1."),
  })
    .describe(
      "Run the next steps only if an element with this text or id is there now; else skip them.",
    )
    .superRefine((value, context) => {
      if (value.text === undefined && value.id === undefined)
        context.addIssue({ code: "custom", message: "if needs text or id" });
    }),
]);

const stepTypes = [
  "click",
  "move",
  "type",
  "paste",
  "key",
  "set_value",
  "select_text",
  "scroll",
  "scroll_to",
  "action",
  "menu",
  "focus",
  "drag",
  "window",
  "wait",
  "wait_for",
  "activate",
  "if",
] as const;

const grammar = [
  "click {id | x,y; button, count, modifiers, hold_ms}",
  "move {id | x,y}: hover",
  "type {text; id}",
  "paste {text; format, id}",
  "key {key; repeat, hold_ms, id}",
  "set_value {id, value}",
  "select_text {id, text; prefix, suffix, cursor}",
  "scroll {direction; id | x,y; pages | pixels}",
  "scroll_to {id}",
  "action {id, name}",
  "menu {path}",
  "focus {id}",
  "drag {from, to; modifiers, hold_ms}",
  "window {op; x,y | width,height}",
  "wait {ms}",
  "wait_for {text | id; gone, timeout_ms}",
  "activate",
  "if {text | id; gone, steps}: run the next steps only if it is there now, else skip them",
].join(" · ");

// Advertised shapes: the strict steps check their bounds.
const anyPoint = z.number();
const anyEndpoint = z.union([
  z.tuple([anyPoint, anyPoint]),
  z.strictObject({ id: z.number().int() }),
]);

/** What the model reads: every field once. Bounds are the widest any step allows. */
const AdvertisedStep = z.strictObject({
  type: z.enum(stepTypes).describe(`Fields after ";" are optional. ${grammar}`),
  id: id.optional(),
  x: anyPoint
    .optional()
    .describe("Screenshot pixel, for things missing from the outline; window move: screen point."),
  y: anyPoint.optional(),
  text: z
    .string()
    .min(1)
    .max(200_000)
    .optional()
    .describe(
      "select_text: exactly as the outline shows it; wait_for, if: text in an element's line.",
    ),
  key: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('"Return", "Escape", "Down", "cmd+n", "shift+Tab".'),
  value: z.union([z.string().max(100_000), z.number(), z.boolean()]).optional(),
  name: z.string().min(1).max(80).optional().describe("One of the element's listed Actions."),
  path: z.array(z.string()).optional().describe('e.g. ["File", "Export…"].'),
  button: z.enum(["left", "right", "middle"]).optional().describe("right opens the context menu."),
  count: z.number().int().min(1).max(3).optional().describe("2 for a double-click."),
  modifiers: z
    .array(z.enum(["cmd", "shift", "alt", "ctrl", "fn"]))
    .optional()
    .describe('Held during the step, e.g. ["cmd"].'),
  hold_ms: z.number().int().optional().describe("Long press, up to 5000."),
  repeat: z.number().int().min(1).max(50).optional(),
  format: z
    .enum(["text", "markdown", "html"])
    .optional()
    .describe("markdown or html paste as rich text."),
  prefix: z
    .string()
    .max(200)
    .optional()
    .describe("Text just before it, when it occurs more than once."),
  suffix: z.string().max(200).optional(),
  cursor: z.enum(["before", "after"]).optional().describe("Place the caret instead of selecting."),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  pages: z.number().min(0.1).max(20).optional().describe("Default 1."),
  pixels: z.number().int().optional(),
  from: anyEndpoint.optional().describe("[x, y] screenshot pixels, or {id}; to as well."),
  to: anyEndpoint.optional(),
  op: z
    .enum(windowOps)
    .optional()
    .describe("On the current window; move and resize take screen points."),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  ms: z.number().int().optional().describe("Up to 10000."),
  gone: z.boolean().optional().describe("Until or only if it is not there."),
  timeout_ms: z.number().int().min(100).max(15_000).optional().describe("Default 5000."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(19)
    .optional()
    .describe("How many steps if guards; default 1."),
});

export const ComputerAction = AdvertisedStep.pipe(StrictStep);
export type ComputerAction = z.infer<typeof ComputerAction>;
