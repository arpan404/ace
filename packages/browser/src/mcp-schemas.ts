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
/** Every page tool takes it: commands on different tabs run at the same time (ADR 0083). */
const tabId = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe("The tab to act in, from browser_tabs or browser_open. Omit for your current tab.");
const tab = { tabId };

export const browserOpenShape = {
  url: url
    .optional()
    .describe(
      "Absolute http(s) URL to load, localhost included. Omit to report the page you are on.",
    ),
  tabId: tabId.describe(
    "Load url in this tab (from browser_tabs). Omit for your current tab; if the person is viewing another agent's tab, you get a tab of your own.",
  ),
  timeout,
};

export const browserTabsShape = {
  action: z
    .enum(["list", "open", "select", "close"])
    .default("list")
    .describe(
      "list: every tab with who opened it, who drives it and its control lease; current marks yours. open: a new tab of your own (url, label) that becomes your current tab. select: make tabId your current tab. close: close tabId.",
    ),
  tabId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("select, close: a tabId from list. Required for both."),
  url: url.optional().describe("open: an http(s) URL to load in the new tab."),
  label: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("open: a short name the person sees on the tab, such as checkout or admin."),
};
type Refine = (input: Record<string, unknown>, context: z.RefinementCtx) => void;
export const checkTabs: Refine = (input, context) => {
  if ((input["action"] === "select" || input["action"] === "close") && !input["tabId"])
    context.addIssue({
      code: "custom",
      path: ["tabId"],
      message: `required for action ${String(input["action"])}`,
    });
};

export const browserSnapshotShape = {
  ...tab,
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
      "click: ref, or x + y for a point (button, clickCount, modifiers optional). hover, focus, check, uncheck: ref. type: ref + text (replaces the field's text). fill_form: fields. press: key, optional ref to focus first. select: ref + values. drag: ref + toRef. upload: ref + files. scroll: x/y pixel deltas. dialog: dialogId + accept.",
    ),
  ref: ref.optional().describe("Element ref from the latest browser_snapshot or browser_find."),
  text: z.string().max(65_536).optional().describe("type: the field's new text."),
  fields: z
    .array(z.object({ ref, value: z.string().max(65_536) }))
    .min(1)
    .max(64)
    .optional()
    .describe("fill_form: text fields to fill, each {ref, value}; values replace the text."),
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
  x: delta
    .optional()
    .describe("scroll: horizontal pixel delta (default 0). click: CSS pixels from the left edge."),
  y: delta
    .optional()
    .describe(
      "scroll: vertical pixel delta; positive scrolls down (default 0). click: CSS pixels from the top edge.",
    ),
  button: z.enum(["left", "middle", "right"]).optional().describe("click: default left."),
  clickCount: z.number().int().min(1).max(3).optional().describe("click: 2 for a double click."),
  modifiers: z
    .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
    .max(4)
    .optional()
    .describe("click: keys held during the click."),
  dialogId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("dialog: pending_dialog.dialogId from a result."),
  accept: z.boolean().optional().describe("dialog: true to accept, false to dismiss."),
  promptText: z.string().max(4096).optional().describe("dialog: text for a prompt() dialog."),
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
  downloads: z
    .literal(true)
    .optional()
    .describe("Wait until the tab's downloads finish; returns them with their saved paths."),
  timeout,
};

/** One condition per wait, so a stray field never silently changes what is awaited. */
export const checkWait: Refine = (input, context) => {
  const given = ["url", "text", "ref", "downloads"].filter((field) => input[field] !== undefined);
  if (given.length !== 1)
    context.addIssue({
      code: "custom",
      path: [given[1] ?? "url"],
      message: "pass exactly one of url, text, ref or downloads",
    });
  if (input["state"] !== undefined && input["ref"] === undefined)
    context.addIssue({ code: "custom", path: ["state"], message: "state needs ref" });
};

export const browserFindShape = {
  ...tab,
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

export const browserScreenshotShape = {
  ...tab,
  fullPage: z.boolean().default(false).describe("The whole scrollable page, not the viewport."),
  ref: ref.optional().describe("Only this element, by its ref from the latest snapshot."),
  format: z
    .enum(["jpeg", "pdf"])
    .default("jpeg")
    .describe("jpeg: an image you see. pdf: print the tab to a PDF file and return its path."),
  landscape: z.boolean().optional().describe("pdf: landscape pages (default false)."),
  printBackground: z
    .boolean()
    .optional()
    .describe("pdf: include background graphics (default true)."),
};
export const checkScreenshot: Refine = (input, context) => {
  const pdf = input["format"] === "pdf";
  const unused = pdf
    ? ["ref", ...(input["fullPage"] === true ? ["fullPage"] : [])]
    : ["landscape", "printBackground"];
  for (const field of unused)
    if (input[field] !== undefined)
      context.addIssue({
        code: "custom",
        path: [field],
        message: `not used with format ${pdf ? "pdf" : "jpeg"}`,
      });
};

export const browserLogsShape = {
  ...tab,
  kind: z
    .enum(["console", "network", "downloads"])
    .optional()
    .describe(
      "Only console messages, only network requests, or the files this thread's tabs downloaded.",
    ),
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
  ...tab,
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
  ...tab,
  direction: z
    .enum(["back", "forward", "reload", "stop"])
    .optional()
    .describe("Omit to read whether back/forward are possible without moving."),
};

const dimension = z.number().int().min(100).max(4096);
export const browserSettingsShape = {
  ...tab,
  action: z
    .enum(["resize", "emulate", "record_start", "record_stop", "extensions", "close"])
    .describe(
      "resize: a tab's viewport width/height. emulate: device metrics, touch, colour scheme. record_start/record_stop: record the tab the person views, attached to the thread. extensions: list the installed extensions (read-only). close: close the whole browser and every tab.",
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

export const browserMeasureShape = { ...tab, ...BrowserMeasurementOptions.shape };
