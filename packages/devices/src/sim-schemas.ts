import { z } from "zod";
import { AppDeviceId, DevicePosture } from "@ace/protocol/devices";
import {
  MachineName,
  ScreenUIAction,
  ScreenUIActOptions,
  type ApprovalTarget,
} from "@ace/protocol";
import { perAction, uiReadShape } from "@ace/screen";
import { deviceInstallTimeoutMs } from "./action-budget.ts";
import { simRefPattern } from "./sim-refs.ts";

const simId = AppDeviceId.describe("From sim_list.");
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
      "Fields after ; are optional. ui: ref; uiAction, value, name. tap: ref | x,y. long_press: ref | x,y; durationMs. type: text; ref. swipe: x,y,toX,toY; durationMs. key: key. open_app: appId. open_url: url. install: path. clipboard_set: text. posture: posture (foldables).",
    ),
  ref: SimRef.optional().describe("From sim_ui; preferred to x,y."),
  uiAction: ScreenUIAction.optional().describe("Default press."),
  value: ScreenUIActOptions.shape.value.describe("For setValue or scroll."),
  name: ScreenUIActOptions.shape.name.describe("For performSecondaryAction."),
  x: point.optional().describe("Screen point: screenshot pixel / scale."),
  y: point.optional(),
  toX: point.optional(),
  toY: point.optional(),
  durationMs: z.number().int().min(1).max(10_000).optional(),
  text: z.string().max(4096).optional(),
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
    .describe("keyboard: show the on-screen keyboard."),
  appId: z.string().min(1).max(256).optional().describe("Bundle id or Android package."),
  url: z.string().min(1).max(4096).optional(),
  path: z.string().min(1).max(4096).optional().describe("Absolute path to a built .app or .apk."),
  posture: DevicePosture.optional(),
});
// `machine` is only in the routed schemas (below); the local ones are strict and refuse it.
const base = ["simId", "machine"] as const;
const none = { required: [], allowed: base };
type SimActInput = z.infer<typeof SimActFields>;
const pointed = new Set(["tap", "long_press"]);
const simActRules = perAction<SimActInput>("action", {
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
});
const simActPoint = (value: SimActInput, context: z.RefinementCtx) => {
  if (!pointed.has(value.action)) return;
  const located = value.x !== undefined || value.y !== undefined;
  if (value.ref !== undefined ? located : value.x === undefined || value.y === undefined)
    context.addIssue({
      code: "custom",
      path: ["ref"],
      message: `${value.action} needs either ref or both x and y`,
    });
};
export const SimActArgs = SimActFields.superRefine(simActRules).superRefine(simActPoint);

export const simSchemas = {
  sim_list: z.strictObject({}),
  sim_start: z.strictObject({
    simId,
    boot: z.boolean().default(true),
  }),
  sim_stop: z.strictObject({ simId }),
  sim_ui: z.strictObject({ simId, ...uiReadShape }),
  sim_act: SimActArgs,
  sim_screenshot: z.strictObject({ simId }),
  sim_logs: z.strictObject({
    simId,
    limit: z.number().int().min(1).max(256).default(100),
  }),
};
export type SimToolName = keyof typeof simSchemas;

const machine = {
  machine: MachineName.optional().describe(
    "Another linked machine's simulators and emulators (machines); omit for this machine.",
  ),
};
/** The sim_* inputs when a host can send them to another linked machine (ADR 0105). */
export const routedSimSchemas = {
  sim_list: simSchemas.sim_list.extend(machine),
  sim_start: simSchemas.sim_start.extend(machine),
  sim_stop: simSchemas.sim_stop.extend(machine),
  sim_ui: simSchemas.sim_ui.extend(machine),
  sim_act: SimActFields.extend(machine).superRefine(simActRules).superRefine(simActPoint),
  sim_screenshot: simSchemas.sim_screenshot.extend(machine),
  sim_logs: simSchemas.sim_logs.extend(machine),
} satisfies Record<SimToolName, z.ZodType>;

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
    description: "List the iOS simulators, Android emulators and Android devices on this machine.",
  },
  sim_start: {
    title: "Start simulator",
    riskClass: "external-effect",
    timeoutMs: 250_000,
    description:
      "Take a simulator for this thread, booting it if needed, so the person can watch. Guide: ace-computer-use.",
  },
  sim_stop: {
    title: "Stop simulator",
    riskClass: "external-effect",
    timeoutMs: 120_000,
    description: "Release the simulator when you finish.",
  },
  sim_ui: {
    title: "Read simulator UI",
    riskClass: "read-only",
    timeoutMs: 120_000,
    description:
      "Read the simulator's accessibility tree, or find elements by role, name or text; refs feed sim_act.",
  },
  sim_act: {
    title: "Act on simulator",
    riskClass: "external-effect",
    // Typing paces each character; installs copy whole app bundles.
    timeoutMs: deviceInstallTimeoutMs + 30_000,
    description:
      "Tap, type, swipe, press keys, open apps or URLs, install, record, use the clipboard or fold the simulator. stale_ref: read sim_ui again.",
  },
  sim_screenshot: {
    title: "Screenshot simulator",
    riskClass: "read-only",
    timeoutMs: 120_000,
    description:
      "Picture of the simulator screen; costlier than sim_ui. Reports its scale to input points.",
  },
  sim_logs: {
    title: "Read simulator logs",
    riskClass: "read-only",
    timeoutMs: 120_000,
    description: "Read the tail of the simulator's logs.",
  },
};
