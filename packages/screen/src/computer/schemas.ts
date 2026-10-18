import { z } from "zod";

const app = z
  .string()
  .min(1)
  .max(200)
  .describe('App name or bundle id, e.g. "Calculator" or "com.apple.TextEdit".');
const id = z.number().int().min(1).describe("Element id from the outline.");
const point = z.number().min(0).max(20_000);
const window = z
  .union([z.number().int().min(1).max(64), z.string().min(1).max(200)])
  .describe("Window number from the Windows line, or part of its title.");

const ComputerAction = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("click"),
    id: id.optional(),
    x: point.optional().describe("Screenshot pixel, when the element is not in the outline."),
    y: point.optional(),
    button: z.enum(["left", "right"]).optional().describe("right opens the context menu."),
    count: z.number().int().min(1).max(3).optional().describe("2 for a double-click."),
  }),
  z.strictObject({ type: z.literal("type"), text: z.string().min(1).max(5000) }),
  z.strictObject({
    type: z.literal("paste"),
    text: z.string().min(1).max(200_000),
    format: z
      .enum(["text", "markdown", "html"])
      .optional()
      .describe("markdown or html paste as rich text."),
  }),
  z.strictObject({
    type: z.literal("key"),
    key: z
      .string()
      .min(1)
      .max(64)
      .describe('A key or chord: "Return", "Escape", "Down", "cmd+n", "shift+Tab".'),
    repeat: z.number().int().min(1).max(50).optional(),
  }),
  z.strictObject({
    type: z.literal("set_value"),
    id,
    value: z.union([z.string().max(100_000), z.number(), z.boolean()]),
  }),
  z.strictObject({
    type: z.literal("select_text"),
    id,
    text: z.string().min(1).max(2000).describe("Text exactly as the outline shows it."),
    prefix: z
      .string()
      .max(200)
      .optional()
      .describe("Text just before it, when it occurs more than once."),
    cursor: z
      .enum(["before", "after"])
      .optional()
      .describe("Place the caret instead of selecting."),
  }),
  z.strictObject({
    type: z.literal("scroll"),
    id: id.optional(),
    x: point.optional(),
    y: point.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    pages: z.number().min(0.1).max(20).optional(),
  }),
  z.strictObject({
    type: z.literal("action"),
    id,
    name: z.string().min(1).max(80).describe("One of the element's listed Actions."),
  }),
  z.strictObject({
    type: z.literal("menu"),
    path: z.array(z.string().min(1).max(120)).min(1).max(8).describe('e.g. ["File", "Export…"].'),
  }),
  z.strictObject({ type: z.literal("focus"), id }),
  z.strictObject({
    type: z.literal("drag"),
    from: z.tuple([point, point]),
    to: z.tuple([point, point]),
  }),
  z.strictObject({ type: z.literal("wait"), ms: z.number().int().min(0).max(10_000) }),
  z.strictObject({ type: z.literal("activate") }),
]);
export type ComputerAction = z.infer<typeof ComputerAction>;

export const computerSchemas = {
  screen_apps: z.strictObject({
    query: z
      .string()
      .max(200)
      .optional()
      .describe("Part of a name or bundle id; also searches installed apps."),
  }),
  screen_state: z.strictObject({
    app,
    window: window.optional(),
    screenshot: z
      .boolean()
      .optional()
      .describe("Also return a picture of the window, with element ids tagged on it."),
    find: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Show only elements whose text contains this, with their parents."),
    full: z.boolean().optional().describe("Return the whole outline instead of changes."),
  }),
  screen_act: z.strictObject({
    app,
    actions: z.array(ComputerAction).min(1).max(20),
    window: window.optional(),
    screenshot: z.boolean().optional().describe("Also return a picture after acting."),
  }),
};

export const computerToolMetadata = {
  screen_apps: {
    title: "List Mac apps",
    riskClass: "read-only" as const,
    timeoutMs: 20_000,
    description:
      "List Mac apps: the running ones, plus installed ones matching query. Pass a name or bundle id to screen_state.",
  },
  screen_state: {
    title: "Look at a Mac app",
    riskClass: "external-effect" as const,
    timeoutMs: 45_000,
    description:
      "Open a Mac app in the background, without taking the person's focus, and read its window as an outline: one numbered element per line. Ids stay the same between calls, so later looks return only what changed. Add screenshot:true to see layout or images; the picture tags elements with their ids. Use find to search a large window. Then act with screen_act. For websites use browser_open.",
  },
  screen_act: {
    title: "Act in a Mac app",
    riskClass: "external-effect" as const,
    timeoutMs: 90_000,
    description:
      'Act in an app in the background, then get what changed. Batch steps that need no look in between, e.g. [{"type":"click","id":12},{"type":"type","text":"hi"},{"type":"key","key":"Return"}]. Click by element id; use x,y screenshot pixels only for things missing from the outline. Prefer set_value for fields, paste for long or formatted text (markdown keeps headings and lists), and menu paths for commands. activate brings the app to the front and interrupts the person: use it only when background actions do not work.',
  },
};
export type ComputerToolName = keyof typeof computerSchemas;
