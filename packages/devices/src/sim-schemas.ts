import { z } from "zod";
import { AppDeviceId, DevicePosture } from "@ace/protocol/devices";
import { ScreenUIAction, ScreenUIActOptions, type ApprovalTarget } from "@ace/protocol";
import { perAction, uiReadShape } from "@ace/screen";
import { deviceInstallTimeoutMs } from "./action-budget.ts";
import { simRefPattern } from "./sim-refs.ts";

const simId = AppDeviceId.describe(
  "Simulator or emulator id from sim_list, e.g. ios:<UDID> or android:<serial>.",
);
const point = z.number().int().min(0).max(16384);
export const SimRef = z.string().regex(simRefPattern, "Expected an element ref like @e3");

const SimActFields = z.strictObject({
  simId,
  action: z
    .enum([
      "ui",
      "tap",
      "long_press",
      "swipe",
      "type",
      "key",
      "open_app",
      "open_url",
      "install",
      "record_start",
      "record_stop",
      "clipboard_get",
      "clipboard_set",
      "posture",
    ])
    .describe(
      "ui: accessibility action on ref. tap/long_press: ref (preferred) or x,y. type: text, into ref when given, else the focused field. swipe: x,y to toX,toY. key: key. open_app: appId. open_url: url. install: path. record_start/record_stop: screen recording attached to the thread. clipboard_get: read the device clipboard. clipboard_set: text onto the clipboard, without pasting. posture: fold a foldable simulator (iPhone Duo) to posture.",
    ),
  ref: SimRef.optional().describe(
    "Element ref from sim_ui, e.g. @e3: required for ui; for tap, long_press and type, instead of x,y.",
  ),
  uiAction: ScreenUIAction.optional().describe("Accessibility action for ui. Default press."),
  value: ScreenUIActOptions.shape.value.describe(
    "setValue text or boolean, or {dx,dy} for scroll.",
  ),
  name: ScreenUIActOptions.shape.name.describe(
    "Secondary action name, for performSecondaryAction.",
  ),
  x: point.optional().describe("Point in screen points (screenshot pixels divided by its scale)."),
  y: point.optional().describe("Point in screen points, like x."),
  toX: point.optional().describe("Swipe end point."),
  toY: point.optional().describe("Swipe end point."),
  durationMs: z.number().int().min(1).max(10_000).optional().describe("Gesture length in ms."),
  text: z.string().max(4096).optional().describe("Text to type, or to put on the clipboard."),
  key: z
    .enum([
      "home",
      "back",
      "rotate",
      "enter",
      "power",
      "recents",
      "volumeUp",
      "volumeDown",
      "action",
      "side",
      "keyboard",
    ])
    .optional()
    .describe(
      "Hardware or navigation key. recents is Android's app overview; action is the iPhone Action button (iPhone 15 Pro and later); side is Apple Watch's side button (home presses its Digital Crown); keyboard brings back the on-screen keyboard (iOS: toggles it; Android: Gboard's show keyboard).",
    ),
  appId: z.string().min(1).max(256).optional().describe("Bundle id or Android package to launch."),
  url: z.string().min(1).max(4096).optional().describe("URL or deep link to open."),
  path: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Absolute path to a Simulator-built .app or an .apk."),
  posture: DevicePosture.optional().describe(
    "closed (cover screen), partiallyOpen (half open, like a book) or open (flat, inner screen). Only foldable simulators; sim_start reports their current posture.",
  ),
});
const base = ["simId"] as const;
const none = { required: [], allowed: base };
type SimActInput = z.infer<typeof SimActFields>;
const pointed = new Set(["tap", "long_press"]);
export const SimActArgs = SimActFields.superRefine(
  perAction<SimActInput>("action", {
    ui: { required: ["ref"], allowed: [...base, "ref", "uiAction", "value", "name"] },
    tap: { required: [], allowed: [...base, "x", "y", "ref"] },
    long_press: { required: [], allowed: [...base, "x", "y", "ref", "durationMs"] },
    swipe: {
      required: ["x", "y", "toX", "toY"],
      allowed: [...base, "x", "y", "toX", "toY", "durationMs"],
    },
    type: { required: ["text"], allowed: [...base, "text", "ref"] },
    key: { required: ["key"], allowed: [...base, "key"] },
    open_app: { required: ["appId"], allowed: [...base, "appId"] },
    open_url: { required: ["url"], allowed: [...base, "url"] },
    install: { required: ["path"], allowed: [...base, "path"] },
    record_start: none,
    record_stop: none,
    clipboard_get: none,
    clipboard_set: { required: ["text"], allowed: [...base, "text"] },
    posture: { required: ["posture"], allowed: [...base, "posture"] },
  }),
).superRefine((value, context) => {
  if (!pointed.has(value.action)) return;
  const located = value.x !== undefined || value.y !== undefined;
  if (value.ref !== undefined ? located : value.x === undefined || value.y === undefined)
    context.addIssue({
      code: "custom",
      path: ["ref"],
      message: `${value.action} needs either ref or both x and y`,
    });
});

export const simSchemas = {
  sim_list: z.strictObject({}),
  sim_start: z.strictObject({
    simId,
    boot: z.boolean().default(true).describe("Boot it first when it is shut down. Default true."),
  }),
  sim_stop: z.strictObject({ simId }),
  sim_ui: z.strictObject({ simId, ...uiReadShape }),
  sim_act: SimActArgs,
  sim_screenshot: z.strictObject({ simId }),
  sim_logs: z.strictObject({
    simId,
    limit: z.number().int().min(1).max(256).default(100).describe("Most recent lines to return."),
  }),
};
export type SimToolName = keyof typeof simSchemas;

export const simToolMetadata: Record<
  SimToolName,
  {
    title: string;
    description: string;
    riskClass: NonNullable<ApprovalTarget["riskClass"]>;
    timeoutMs: number;
  }
> = {
  sim_list: {
    title: "List simulators",
    riskClass: "read-only",
    timeoutMs: 120_000,
    description:
      "List the iOS simulators and Android emulators ace can drive on this machine, with simIds and status. Not for paired machines (machines).",
  },
  sim_start: {
    title: "Start simulator",
    riskClass: "external-effect",
    timeoutMs: 250_000,
    description:
      "Take a simulator for this thread, boot it if needed and start capture so the person can watch in ace. Refused while a person or another agent holds it. Then sim_ui.",
  },
  sim_stop: {
    title: "Stop simulator",
    riskClass: "external-effect",
    timeoutMs: 120_000,
    description: "Stop capture and release the simulator when you finish.",
  },
  sim_ui: {
    title: "Read simulator UI",
    riskClass: "read-only",
    timeoutMs: 120_000,
    description:
      "Read the simulator's accessibility tree, or pass role, name or text to find matching elements. Actionable elements carry refs like @e3 for sim_act.",
  },
  sim_act: {
    title: "Act on simulator",
    riskClass: "external-effect",
    // Typing paces each character; installs copy whole app bundles.
    timeoutMs: deviceInstallTimeoutMs + 30_000,
    description:
      "Act on the simulator: tap, long_press or type on a sim_ui ref (preferred) or a point, ui accessibility actions on a ref, swipe, key, open_app, open_url, install, start/stop a recording, read/set the clipboard, or fold a foldable one (posture). A ref whose element has gone fails with stale_ref.",
  },
  sim_screenshot: {
    title: "Screenshot simulator",
    riskClass: "read-only",
    timeoutMs: 120_000,
    description:
      "Visual check of the simulator screen, with or without the live view. Costs more tokens than sim_ui. Reports the scale between image pixels and input points.",
  },
  sim_logs: {
    title: "Read simulator logs",
    riskClass: "read-only",
    timeoutMs: 120_000,
    description: "Read a bounded tail of the simulator's logs.",
  },
};
