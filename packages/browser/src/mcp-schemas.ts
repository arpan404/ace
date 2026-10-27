import { z } from "zod";
import { BrowserMeasurementOptions, browserWaitLimitMs } from "@ace/protocol";

// Tool inputs are what a model reads; the service re-validates each command it builds.
const ref = z.string().min(1).max(256);
const url = z.string().min(1).max(8192);
const timeout = z.number().int().min(1).max(browserWaitLimitMs).default(10_000).describe("ms");
/** Every page tool takes it: commands on different tabs run at the same time (ADR 0083). */
const tabId = z.string().min(1).max(256).optional();
const tab = { tabId };

export const browserOpenShape = {
  url: url.optional().describe("http(s) URL, localhost too."),
  tabId,
  timeout,
  waitUntil: z.enum(["domcontentloaded", "load", "networkidle"]).optional(),
};

export const browserTabsShape = {
  action: z
    .enum(["list", "open", "select", "keep", "close"])
    .default("list")
    .describe("open: url, label, keep; becomes your current tab. select, keep, close: tabId."),
  tabId: z.string().min(1).max(256).optional(),
  url: url.optional(),
  label: z.string().min(1).max(64).optional(),
  keep: z.boolean().optional().describe("true: stays after your turn."),
};
type Refine = (input: Record<string, unknown>, context: z.RefinementCtx) => void;
export const checkTabs: Refine = (input, context) => {
  const needsTab = ["select", "keep", "close"].includes(String(input["action"]));
  if (needsTab && !input["tabId"])
    context.addIssue({
      code: "custom",
      path: ["tabId"],
      message: `required for action ${String(input["action"])}`,
    });
};

export const browserSnapshotShape = {
  ...tab,
  ref: ref.optional().describe("A container's ref: read only its subtree."),
  interactiveOnly: z.boolean().default(false),
  maxNodes: z.number().int().min(1).max(2000).default(80),
  depth: z.number().int().min(1).max(64).optional(),
};

const actKinds = [
  "click",
  "type",
  "fill_form",
  "press",
  "hover",
  "select",
  "check",
  "uncheck",
  "drag",
  "focus",
  "upload",
  "scroll",
  "dialog",
] as const;
export type BrowserActKind = (typeof actKinds)[number];
/** Fields each action needs; the rest are refused so a wrong field never silently does nothing. */
const actFields: Record<BrowserActKind, { required: string[]; optional?: string[] }> = {
  click: { required: [], optional: ["ref", "x", "y", "button", "clickCount", "modifiers"] },
  type: { required: ["ref", "text"] },
  fill_form: { required: ["fields"] },
  press: { required: ["key"], optional: ["ref"] },
  hover: { required: ["ref"] },
  select: { required: ["ref", "values"] },
  check: { required: ["ref"] },
  uncheck: { required: ["ref"] },
  drag: { required: ["ref", "toRef"] },
  focus: { required: ["ref"] },
  upload: { required: ["ref", "files"] },
  scroll: { required: [], optional: ["x", "y"] },
  dialog: { required: ["dialogId", "accept"], optional: ["promptText"] },
};
const delta = z.number().finite().min(-100_000).max(100_000);
export const browserActShape = {
  ...tab,
  action: z
    .enum(actKinds)
    .describe(
      "Fields after ; are optional. click: ref | x,y; button, clickCount, modifiers. hover, focus, check, uncheck: ref. type: ref, text. fill_form: fields. press: key; ref. select: ref, values. drag: ref, toRef. upload: ref, files. scroll: x, y. dialog: dialogId, accept; promptText.",
    ),
  ref: ref.optional(),
  text: z.string().max(65_536).optional(),
  fields: z
    .array(z.object({ ref, value: z.string().max(65_536) }))
    .min(1)
    .max(64)
    .optional(),
  key: z.string().min(1).max(256).optional().describe("e.g. Enter, ArrowDown, Control+a."),
  values: z.array(z.string().max(4096)).min(1).max(100).optional(),
  toRef: ref.optional(),
  files: z.array(z.string().min(1).max(8192)).min(1).max(16).optional(),
  x: delta.optional().describe("click: CSS px; scroll: delta."),
  y: delta.optional(),
  button: z.enum(["left", "middle", "right"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  modifiers: z
    .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
    .max(4)
    .optional(),
  dialogId: z.string().min(1).max(256).optional().describe("From pending_dialog."),
  accept: z.boolean().optional(),
  promptText: z.string().max(4096).optional(),
};
/** Fields every browser tool may carry whatever its action. */
const routing = ["action", "tabId", "machine", "browser"];
export const checkAct: Refine = (input, context) => {
  const action = z.enum(actKinds).parse(input["action"]);
  const fields = actFields[action];
  const allowed = new Set([...routing, ...fields.required, ...(fields.optional ?? [])]);
  for (const field of fields.required)
    if (Reflect.get(input, field) === undefined)
      context.addIssue({ code: "custom", path: [field], message: `required for action ${action}` });
  for (const [field, value] of Object.entries(input))
    if (value !== undefined && !allowed.has(field))
      context.addIssue({ code: "custom", path: [field], message: `not used by action ${action}` });
  if (
    action === "click" &&
    input["ref"] === undefined &&
    (input["x"] === undefined || input["y"] === undefined)
  )
    context.addIssue({ code: "custom", path: ["ref"], message: "click needs ref, or x and y" });
};

export const browserWaitShape = {
  ...tab,
  url: url.optional().describe("Exact, or a glob with *."),
  text: z.string().min(1).max(4096).optional(),
  ref: ref.optional(),
  state: z.enum(["visible", "hidden"]).optional().describe("Required with ref."),
  networkIdle: z.literal(true).optional().describe("No request for 500 ms."),
  timeMs: z.number().int().min(1).max(60_000).optional(),
  downloads: z.literal(true).optional().describe("Returns their paths."),
  timeout,
};

/** One condition per wait, so a stray field never silently changes what is awaited. */
export const checkWait: Refine = (input, context) => {
  const given = ["url", "text", "ref", "networkIdle", "timeMs", "downloads"].filter(
    (field) => input[field] !== undefined,
  );
  if (given.length !== 1)
    context.addIssue({
      code: "custom",
      path: [given[1] ?? "url"],
      message: "pass exactly one of url, text, ref, networkIdle, timeMs or downloads",
    });
  if (input["state"] !== undefined && input["ref"] === undefined)
    context.addIssue({ code: "custom", path: ["state"], message: "state needs ref" });
};

export const browserFindShape = {
  ...tab,
  role: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(1024).optional().describe("Substring unless exact."),
  query: z.string().min(1).max(1024).optional().describe("Same as name."),
  exact: z.boolean().default(false),
  text: z.string().min(1).max(4096).optional(),
};

export const browserScreenshotShape = {
  ...tab,
  fullPage: z.boolean().default(false),
  ref: ref.optional(),
  sizes: z
    .array(z.enum(["phone", "tablet", "desktop"]))
    .min(1)
    .max(3)
    .optional()
    .describe("Responsive check: one image per width."),
  format: z.enum(["jpeg", "pdf"]).default("jpeg"),
  landscape: z.boolean().optional(),
  printBackground: z.boolean().optional(),
};
export const checkScreenshot: Refine = (input, context) => {
  const pdf = input["format"] === "pdf";
  const unused = pdf
    ? ["ref", "sizes", ...(input["fullPage"] === true ? ["fullPage"] : [])]
    : ["landscape", "printBackground", ...(input["sizes"] !== undefined ? ["ref"] : [])];
  for (const field of unused)
    if (input[field] !== undefined)
      context.addIssue({
        code: "custom",
        path: [field],
        message:
          field === "ref" && !pdf
            ? "not used with sizes"
            : `not used with format ${pdf ? "pdf" : "jpeg"}`,
      });
};

export const browserLogsShape = {
  ...tab,
  kind: z.enum(["console", "network", "downloads"]).optional(),
  level: z.enum(["error", "warning", "info", "log", "debug"]).optional(),
  url: z.string().max(8192).optional().describe("URL substring."),
  status: z.number().int().min(100).max(599).optional(),
  limit: z.number().int().min(1).max(200).default(25),
  requestId: z.string().min(1).max(256).optional().describe("From a network entry."),
};

export const browserEvaluateShape = {
  ...tab,
  expression: z.string().max(65_536),
  mode: z.enum(["read-only", "unrestricted"]).default("unrestricted"),
};

export const browserHistoryShape = {
  ...tab,
  direction: z.enum(["back", "forward", "reload", "stop"]).optional(),
};

const dimension = z.number().int().min(100).max(4096);
export const browserSettingsShape = {
  ...tab,
  action: z.enum(["resize", "emulate", "record_start", "record_stop", "extensions", "close"]),
  width: dimension.optional().describe("resize, emulate: CSS px."),
  height: dimension.optional(),
  deviceScaleFactor: z.number().min(0.5).max(4).default(1),
  mobile: z.boolean().default(false),
  touch: z.boolean().default(false),
  colorScheme: z.enum(["light", "dark", "no-preference"]).default("light"),
  userAgent: z.string().max(1024).optional(),
};
export const checkSettings: Refine = (input, context) => {
  if (input["action"] !== "resize" && input["action"] !== "emulate") return;
  for (const field of ["width", "height"])
    if (input[field] === undefined)
      context.addIssue({
        code: "custom",
        path: [field],
        message: `required for action ${String(input["action"])}`,
      });
};

export const browserMeasureShape = { ...tab, ...BrowserMeasurementOptions.shape };
