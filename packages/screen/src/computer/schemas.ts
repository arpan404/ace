import { z } from "zod";
import { ComputerAction } from "./actions.ts";
import { conditionProblem } from "./conditions.ts";

export { ComputerAction } from "./actions.ts";

/** Where the engine runs; tool text names that platform's apps and identities. */
export type ComputerPlatform = "macos" | "linux" | "windows";

const appIds = {
  macos: {
    app: 'App name or bundle id, e.g. "Calculator" or "com.apple.TextEdit".',
    query: "Part of a name or bundle id; also searches installed apps.",
  },
  linux: {
    app: 'App name or desktop-file id, e.g. "Text Editor" or "org.gnome.TextEditor".',
    query: "Part of a name or desktop-file id; also searches installed apps.",
  },
  windows: {
    app: 'App name, app id or .exe path, e.g. "Notepad", "notepad.exe" or "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App".',
    query: "Part of a name or app id; also searches Start menu apps.",
  },
} as const;

const window = z
  .union([z.number().int().min(1).max(64), z.string().min(1).max(200)])
  .describe("Window number from the Windows line, or part of its title.");

export function computerSchemasFor(platform: ComputerPlatform) {
  const app = z.string().min(1).max(200).describe(appIds[platform].app);
  return {
    screen_apps: z.strictObject({
      query: z.string().max(200).optional().describe(appIds[platform].query),
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
        .describe(
          "false: skip reading the window afterwards, when the next step is a look anyway.",
        ),
    }),
  };
}

/** The macOS schemas; the action shapes are the same on every platform. */
export const computerSchemas = computerSchemasFor("macos");

const looks =
  "Ids stay the same between calls, so later looks return only what changed. Add screenshot:true to see layout or images; the picture tags elements with their ids. outline:false returns just the picture, fastest. Use find to search a large window. Then act with screen_act. For websites use browser_open.";
const batching =
  'Batch steps that need no look in between, e.g. [{"type":"click","id":12},{"type":"type","text":"hi"},{"type":"key","key":"Return"}]. Act by element id; use x,y screenshot pixels only for things missing from the outline. Prefer set_value for fields, paste for long or formatted text (markdown keeps headings and lists) and menu paths for commands. wait_for and if let one batch handle a dialog that may or may not show.';

const text = {
  macos: {
    appsTitle: "List Mac apps",
    apps: "List Mac apps: the running ones, plus installed ones matching query. Pass a name or bundle id to screen_state.",
    stateTitle: "Look at a Mac app",
    state: `Open a Mac app in the background, without taking the person's focus, and read its window as an outline: one numbered element per line. ${looks}`,
    actTitle: "Act in a Mac app",
    act: `Act in an app in the background, then get what changed. ${batching} activate brings the app to the front and interrupts the person: use it only when background actions do not work.`,
  },
  linux: {
    appsTitle: "List desktop apps",
    apps: "List the desktop's apps: the running ones, plus installed ones matching query. Pass a name or desktop-file id to screen_state.",
    stateTitle: "Look at a desktop app",
    state: `Open a desktop app, without taking the person's focus, and read its window through accessibility as an outline: one numbered element per line. ${looks}`,
    actTitle: "Act in a desktop app",
    act: `Act in an app in the background, through accessibility, then get what changed. ${batching} Clicks (by id, or at screenshot x,y), typing, set_value, menus, menu shortcuts, copy/paste and Tab work without the window in front. Hover and drags can't be sent. Typing into Chromium and Electron apps, and keys with no accessible equivalent, need activate first in the same batch: they are then typed in front, taking the person's focus (GNOME, KDE). Linux shortcuts use ctrl, e.g. ctrl+s.`,
  },
  windows: {
    appsTitle: "List Windows apps",
    apps: "List Windows apps: the running ones, plus Start menu apps matching query. Pass a name or app id to screen_state.",
    stateTitle: "Look at a Windows app",
    state: `Open a Windows app without taking the person's focus, and read its window through UI Automation as an outline: one numbered element per line. ${looks}`,
    actTitle: "Act in a Windows app",
    act: `Act in an app in the background, then get what changed. ${batching} Clicks by id, set_value, select_text, typing into fields, menus, menu shortcuts and window steps work with the window in the background. Other shortcuts, x,y clicks on things missing from the outline, hover and drags need the window in front: start the batch with activate, which interrupts the person. Windows shortcuts use ctrl, e.g. ctrl+s; cmd means ctrl.`,
  },
} as const;

export function computerToolMetadataFor(platform: ComputerPlatform) {
  const words = text[platform];
  return {
    screen_apps: {
      title: words.appsTitle,
      riskClass: "read-only" as const,
      timeoutMs: 20_000,
      description: words.apps,
    },
    screen_state: {
      title: words.stateTitle,
      riskClass: "external-effect" as const,
      timeoutMs: 45_000,
      description: words.state,
    },
    screen_act: {
      title: words.actTitle,
      riskClass: "external-effect" as const,
      timeoutMs: 90_000,
      description: words.act,
    },
  };
}
export type ComputerToolName = keyof ReturnType<typeof computerSchemasFor>;
