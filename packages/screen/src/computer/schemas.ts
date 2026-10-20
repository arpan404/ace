import { z } from "zod";
import { ComputerAction } from "./actions.ts";
import { conditionProblem } from "./conditions.ts";

export { ComputerAction } from "./actions.ts";

const app = z
  .string()
  .min(1)
  .max(200)
  .describe('App name or bundle id, e.g. "Calculator" or "com.apple.TextEdit".');
const window = z
  .union([z.number().int().min(1).max(64), z.string().min(1).max(200)])
  .describe("Window number from the Windows line, or part of its title.");

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
    outline: z
      .boolean()
      .optional()
      .describe("false: return only the screenshot, without reading elements (fastest)."),
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
    actions: z
      .array(ComputerAction)
      .min(1)
      .max(20)
      .superRefine((actions, context) => {
        const problem = conditionProblem(actions);
        if (problem) context.addIssue({ code: "custom", message: problem });
      }),
    window: window.optional(),
    screenshot: z.boolean().optional().describe("Also return a picture after acting."),
    observe: z
      .boolean()
      .optional()
      .describe("false: skip reading the window afterwards, when the next step is a look anyway."),
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
      "Open a Mac app in the background, without taking the person's focus, and read its window as an outline: one numbered element per line. Ids stay the same between calls, so later looks return only what changed. Add screenshot:true to see layout or images; the picture tags elements with their ids. outline:false returns just the picture, fastest. Use find to search a large window. Then act with screen_act. For websites use browser_open.",
  },
  screen_act: {
    title: "Act in a Mac app",
    riskClass: "external-effect" as const,
    timeoutMs: 90_000,
    description:
      'Act in an app in the background, then get what changed. Batch steps that need no look in between, e.g. [{"type":"click","id":12},{"type":"type","text":"hi"},{"type":"key","key":"Return"}]. Act by element id; use x,y screenshot pixels only for things missing from the outline. Prefer set_value for fields, paste for long or formatted text (markdown keeps headings and lists) and menu paths for commands. wait_for and if let one batch handle a dialog that may or may not show. activate brings the app to the front and interrupts the person: use it only when background actions do not work.',
  },
};
export type ComputerToolName = keyof typeof computerSchemas;
