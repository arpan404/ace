import { z } from "zod";
import { BrowserMeasurementOptions, browserWaitLimitMs } from "@ace/protocol";

// Tool inputs are what a model reads; the service re-validates each command it builds.
const ref = z.string().min(1).max(256);
const url = z.string().min(1).max(8192);
const timeout = z
  .number()
  .int()
  .min(1)
  .max(browserWaitLimitMs)
  .default(10_000)
  .describe("Milliseconds to wait before failing with timeout.");

export const browserOpenShape = {
  url: url
    .optional()
    .describe(
      "Absolute http(s) URL to load, localhost included. Omit to report the current page and tabs.",
    ),
  tabId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Switch to one of the open tabs listed by an earlier browser_open result."),
  timeout,
};

export const browserSnapshotShape = {
  ref: ref
    .optional()
    .describe("A container's ref from the latest snapshot: return only its subtree."),
  interactiveOnly: z
    .boolean()
    .default(false)
    .describe("Only actionable elements (buttons, links, fields), as a flat list."),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(120)
    .describe("Most lines to return; the result says when more exist."),
};

const actKinds = [
  "click",
  "type",
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
  click: { required: ["ref"] },
  type: { required: ["ref", "text"] },
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
  action: z
    .enum(actKinds)
    .describe(
      "click, hover, focus, check, uncheck: ref. type: ref + text (replaces the field's text). press: key, optional ref to focus first. select: ref + values. drag: ref + toRef. upload: ref + files. scroll: x/y pixel deltas. dialog: dialogId + accept.",
    ),
  ref: ref.optional().describe("Element ref from the latest browser_snapshot or browser_find."),
  text: z.string().max(65_536).optional().describe("type: the field's new text."),
  key: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("press: a key or chord such as Enter, Tab, Escape, ArrowDown or Control+a."),
  values: z
    .array(z.string().max(4096))
    .min(1)
    .max(100)
    .optional()
    .describe("select: option values to select in a native <select>."),
  toRef: ref.optional().describe("drag: the drop target's ref."),
  files: z
    .array(z.string().min(1).max(8192))
    .min(1)
    .max(16)
    .optional()
    .describe("upload: paths of files in the workspace or thread artifacts."),
  x: delta.optional().describe("scroll: horizontal pixel delta (default 0)."),
  y: delta.optional().describe("scroll: vertical pixel delta; positive scrolls down (default 0)."),
  dialogId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("dialog: pending_dialog.dialogId from a result."),
  accept: z.boolean().optional().describe("dialog: true to accept, false to dismiss."),
  promptText: z.string().max(4096).optional().describe("dialog: text for a prompt() dialog."),
};
type Refine = (input: Record<string, unknown>, context: z.RefinementCtx) => void;
export const checkAct: Refine = (input, context) => {
  const fields = actFields[z.enum(actKinds).parse(input["action"])];
  const allowed = new Set(["action", "machine", ...fields.required, ...(fields.optional ?? [])]);
  for (const field of fields.required)
    if (Reflect.get(input, field) === undefined)
      context.addIssue({
        code: "custom",
        path: [field],
        message: `required for action ${String(input["action"])}`,
      });
  for (const [field, value] of Object.entries(input))
    if (value !== undefined && !allowed.has(field))
      context.addIssue({
        code: "custom",
        path: [field],
        message: `not used by action ${String(input["action"])}`,
      });
};

export const browserWaitShape = {
  url: url
    .optional()
    .describe(
      "Exact destination URL; also waits for DOMContentLoaded. Works before or after navigation commits.",
    ),
  text: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Visible page text to wait for, matched as a substring."),
  ref: ref.optional().describe("Element ref from the latest snapshot; use with state."),
  state: z.enum(["visible", "hidden"]).optional().describe("Required with ref."),
  timeout,
};

export const browserFindShape = {
  role: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Accessible role, e.g. button, link, textbox, heading, checkbox."),
  name: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe("Accessible name; a case-insensitive substring unless exact is true."),
  exact: z.boolean().default(false).describe("Match the whole name exactly."),
  text: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Visible page text to locate instead of role/name; reports whether it was found."),
};

export const browserLogsShape = {
  kind: z
    .enum(["console", "network"])
    .optional()
    .describe("Only console messages or only network requests."),
  level: z
    .enum(["error", "warning", "info", "log", "debug"])
    .optional()
    .describe("Console level to keep."),
  url: z.string().max(8192).optional().describe("Keep entries whose URL contains this text."),
  status: z
    .number()
    .int()
    .min(100)
    .max(599)
    .optional()
    .describe("Keep network entries with this HTTP status."),
  limit: z.number().int().min(1).max(200).default(50).describe("Most recent entries to return."),
  requestId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Return this network request's response body (requestId from an earlier entry)."),
};

export const browserEvaluateShape = {
  expression: z
    .string()
    .max(65_536)
    .describe(
      "JavaScript expression evaluated in the page; promises are awaited and the value returned as JSON.",
    ),
  mode: z
    .enum(["read-only", "unrestricted"])
    .default("unrestricted")
    .describe("read-only refuses scripts that change the page; unrestricted runs anything."),
};

export const browserHistoryShape = {
  direction: z
    .enum(["back", "forward", "reload", "stop"])
    .optional()
    .describe("Omit to read whether back/forward are possible without moving."),
};

const dimension = z.number().int().min(100).max(4096);
export const browserSettingsShape = {
  action: z
    .enum(["resize", "emulate", "record_start", "record_stop", "close"])
    .describe(
      "resize: viewport width/height. emulate: device metrics, touch, colour scheme. record_start/record_stop: a recording attached to the thread. close: close the browser.",
    ),
  width: dimension.optional().describe("resize/emulate: viewport width in CSS pixels."),
  height: dimension.optional().describe("resize/emulate: viewport height in CSS pixels."),
  deviceScaleFactor: z.number().min(0.5).max(4).default(1).describe("emulate: device pixel ratio."),
  mobile: z.boolean().default(false).describe("emulate: mobile viewport behaviour."),
  touch: z.boolean().default(false).describe("emulate: touch events."),
  colorScheme: z
    .enum(["light", "dark", "no-preference"])
    .default("light")
    .describe("emulate: prefers-color-scheme."),
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

export const browserMeasureShape = BrowserMeasurementOptions.shape;
