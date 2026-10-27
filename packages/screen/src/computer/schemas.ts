import { z } from "zod";
import { ComputerAction } from "./actions.ts";
import { conditionProblem } from "./conditions.ts";

export { ComputerAction } from "./actions.ts";

/** Where the engine runs; tool text names that platform's apps and identities. */
export type ComputerPlatform = "macos" | "linux" | "windows";

const appIds = {
  macos: {
    app: 'Name or bundle id, e.g. "Calculator".',
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
  .describe("Number from the Windows line, or part of a title.");

export function computerSchemasFor(platform: ComputerPlatform) {
  const app = z.string().min(1).max(200).describe(appIds[platform].app);
  return {
    screen_apps: z.strictObject({
      query: z.string().max(200).optional().describe(appIds[platform].query),
    }),
    screen_state: z.strictObject({
      app,
      window: window.optional(),
      screenshot: z.boolean().optional().describe("Also a picture, elements tagged with ids."),
      outline: z.boolean().optional().describe("false: picture only (fastest)."),
      find: z.string().min(1).max(200).optional().describe("Only elements with this text."),
      full: z.boolean().optional().describe("Whole outline, not changes."),
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
      screenshot: z.boolean().optional().describe("Also a picture after acting."),
      observe: z.boolean().optional().describe("false: skip the look afterwards."),
    }),
  };
}

/** The macOS schemas; the action shapes are the same on every platform. */
export const computerSchemas = computerSchemasFor("macos");
export const computerToolNames = Object.keys(computerSchemas);

const looks =
  "Ids are stable, so later looks return only changes. For websites use browser_open. Guide: ace-computer-use.";
const batching =
  'Batch steps that need no look between, e.g. [{"type":"click","id":12},{"type":"type","text":"hi"}]. Act by id; x,y screenshot pixels only for what the outline lacks. Prefer set_value, paste and menu.';

const text = {
  macos: {
    appsTitle: "List Mac apps",
    apps: "List running Mac apps, plus installed ones matching query, for screen_state.",
    stateTitle: "Look at a Mac app",
    state: `Open a Mac app in the background and read its window as an outline of numbered elements. ${looks}`,
    actTitle: "Act in a Mac app",
    act: `Act in an app in the background, then get what changed. ${batching} activate interrupts the person: last resort.`,
  },
  linux: {
    appsTitle: "List desktop apps",
    apps: "List running desktop apps, plus installed ones matching query, for screen_state.",
    stateTitle: "Look at a desktop app",
    state: `Open a desktop app in the background and read its window as an outline of numbered elements. ${looks}`,
    actTitle: "Act in a desktop app",
    act: `Act in an app in the background, then get what changed. ${batching} No hover or drags. Typing into Chromium or Electron apps needs activate first in the batch, which takes the person's focus. Shortcuts use ctrl.`,
  },
  windows: {
    appsTitle: "List Windows apps",
    apps: "List running Windows apps, plus Start menu apps matching query, for screen_state.",
    stateTitle: "Look at a Windows app",
    state: `Open a Windows app in the background and read its window as an outline of numbered elements. ${looks}`,
    actTitle: "Act in a Windows app",
    act: `Act in an app in the background, then get what changed. ${batching} Other shortcuts, x,y clicks, hover and drags need activate first in the batch, which interrupts the person. Shortcuts use ctrl.`,
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
