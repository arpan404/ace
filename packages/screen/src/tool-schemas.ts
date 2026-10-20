import {
  ScreenAppURL,
  ScreenBundle,
  ScreenId,
  ScreenKey,
  ScreenKeyModifiers,
  ScreenMeasurementAction,
  ScreenUIAction,
  ScreenUIActOptions,
  ScreenUIRef,
  type ApprovalTarget,
} from "@ace/protocol";
import { z } from "zod";

const sessionId = ScreenId.optional().describe(
  "sessionId from screen_open_app. Omit when this thread controls one app.",
);
const windowId = z.number().int().positive();
const coordinate = z.number().finite().nonnegative();
const delta = z.number().int().min(-1000).max(1000);

/** Fields an action needs, and fields it never reads; both are argument errors. */
export function perAction<T extends Record<string, unknown>>(
  key: keyof T & string,
  fields: Record<string, { required: readonly string[]; allowed: readonly string[] }>,
) {
  return (value: T, context: z.RefinementCtx) => {
    const rule = fields[String(value[key])];
    if (!rule) return;
    for (const field of rule.required)
      if (value[field] === undefined)
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Required when ${key} is ${String(value[key])}`,
        });
    for (const [field, present] of Object.entries(value))
      if (present !== undefined && field !== key && !rule.allowed.includes(field))
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Not used when ${key} is ${String(value[key])}`,
        });
  };
}

const ScreenInputFields = z.strictObject({
  sessionId,
  action: z
    .enum(["click", "type", "key", "scroll", "paste"])
    .describe(
      "click needs x,y; type and paste need text; key needs key (plus modifiers); scroll needs dx,dy and optional x,y.",
    ),
  x: coordinate
    .optional()
    .describe("Target-window point (screenshot pixels divided by its scale)."),
  y: coordinate.optional().describe("Target-window point, like x."),
  button: z.enum(["left", "right"]).optional().describe("Mouse button for click. Default left."),
  text: z.string().max(4096).optional().describe("Text to type or paste."),
  key: ScreenKey.optional().describe("One named key, without modifiers, e.g. Enter, Tab, l."),
  modifiers: ScreenKeyModifiers.unwrap().optional().describe("Modifiers held with key."),
  dx: delta.optional().describe("Horizontal scroll distance in points."),
  dy: delta.optional().describe("Vertical scroll distance in points; positive scrolls down."),
});
const session = ["sessionId"] as const;
export const ScreenInputArgs = ScreenInputFields.superRefine(
  perAction<z.infer<typeof ScreenInputFields>>("action", {
    click: { required: ["x", "y"], allowed: [...session, "x", "y", "button"] },
    type: { required: ["text"], allowed: [...session, "text"] },
    paste: { required: ["text"], allowed: [...session, "text"] },
    key: { required: ["key"], allowed: [...session, "key", "modifiers"] },
    scroll: { required: ["dx", "dy"], allowed: [...session, "x", "y", "dx", "dy"] },
  }),
);

const UIActFields = z.strictObject({
  sessionId,
  ref: ScreenUIRef.optional().describe("Element ref from screen_ui_tree."),
  action: ScreenUIAction.optional().describe("Accessibility action to perform on ref."),
  name: ScreenUIActOptions.shape.name.describe(
    "Secondary action name, for performSecondaryAction.",
  ),
  range: ScreenUIActOptions.shape.range.describe("Text range, for selectText."),
  value: ScreenUIActOptions.shape.value.describe(
    "setValue text or boolean, or {dx,dy} for scroll.",
  ),
  menu: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(8)
    .optional()
    .describe('Menu path to press instead of a ref, e.g. ["File","New Window"].'),
});
export const ScreenUIActArgs = UIActFields.superRefine((value, context) => {
  if (value.menu !== undefined) {
    for (const field of ["ref", "action", "name", "range", "value"] as const)
      if (value[field] !== undefined)
        context.addIssue({ code: "custom", path: [field], message: "Not used with menu" });
    return;
  }
  for (const field of ["ref", "action"] as const)
    if (value[field] === undefined)
      context.addIssue({ code: "custom", path: [field], message: "Required without menu" });
});

/** Read fields shared by screen_ui_tree and sim_ui: a query runs a find, otherwise the tree. */
export const uiReadShape = {
  role: z.string().min(1).max(128).optional().describe("Find elements with this role."),
  name: z.string().min(1).max(256).optional().describe("Find elements whose name matches."),
  text: z.string().min(1).max(512).optional().describe("Find elements containing this text."),
  limit: z.number().int().min(1).max(64).default(16).describe("Most matches a find returns."),
  maxDepth: z.number().int().min(0).max(16).default(8).describe("Tree depth without a query."),
  maxNodes: z.number().int().min(1).max(512).default(128).describe("Tree nodes without a query."),
};
type UIRead = {
  role?: string | undefined;
  name?: string | undefined;
  text?: string | undefined;
  limit: number;
};
type UITree = { maxDepth: number; maxNodes: number };
/** The manager call a read maps to: find when any query field is present. */
export function uiReadRequest(args: UIRead & UITree):
  | {
      kind: "find";
      options: { query: { role?: string; name?: string; text?: string }; limit: number };
    }
  | { kind: "tree"; options: UITree } {
  const query = Object.fromEntries(
    (["role", "name", "text"] as const).flatMap((key) =>
      args[key] === undefined ? [] : [[key, args[key]]],
    ),
  );
  return Object.keys(query).length
    ? { kind: "find", options: { query, limit: args.limit } }
    : { kind: "tree", options: { maxDepth: args.maxDepth, maxNodes: args.maxNodes } };
}

export const computerUseSchemas = {
  screen_open_app: z.strictObject({
    bundleId: ScreenBundle.describe("Exact macOS bundle id, e.g. com.apple.TextEdit."),
    windowId: windowId
      .optional()
      .describe(
        "A windowId from screen_windows or an earlier result. On an app you already control, switches to that window.",
      ),
    url: ScreenAppURL.optional().describe(
      "URL or deep link to open in the app once acquired. For websites use browser_open.",
    ),
    mode: z
      .enum(["background", "foreground"])
      .optional()
      .describe(
        "foreground activates the app and uses the real cursor and keyboard; use it only when the app ignores background input. Omitted keeps the current mode (new sessions start in background).",
      ),
  }),
  screen_windows: z.strictObject({
    bundleId: ScreenBundle.describe("Exact macOS bundle id."),
  }),
  screen_ui_tree: z.strictObject({ sessionId, ...uiReadShape }),
  screen_ui_act: ScreenUIActArgs,
  screen_input: ScreenInputArgs,
  screen_screenshot: z.strictObject({ sessionId }),
  screen_measure: z.strictObject({
    sessionId,
    action: ScreenMeasurementAction.optional().describe(
      "Input to perform and measure. Omit to observe only.",
    ),
    observeMs: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(2000)
      .describe("How long to watch per run."),
    repeat: z.number().int().min(1).max(5).default(1).describe("Runs; repeats redo the action."),
    filmstrip: z.boolean().default(true).describe("Attach a timestamped filmstrip image."),
  }),
};
export type ScreenToolName = keyof typeof computerUseSchemas;

export const screenToolMetadata: Record<
  ScreenToolName,
  {
    title: string;
    description: string;
    riskClass: NonNullable<ApprovalTarget["riskClass"]>;
    timeoutMs: number;
  }
> = {
  screen_open_app: {
    title: "Open native app",
    riskClass: "external-effect",
    timeoutMs: 15_000,
    description:
      "Launch or rejoin a macOS app by bundle id and take a background session the person can watch. Returns sessionId and candidate windows. Pass windowId to pick or switch window, url for a deep link, mode for foreground input. Then screen_ui_tree. For websites use browser_open.",
  },
  screen_windows: {
    title: "List app windows",
    riskClass: "read-only",
    timeoutMs: 15_000,
    description: "List an app's windows with windowIds. Pass one to screen_open_app.",
  },
  screen_ui_tree: {
    title: "Read app UI",
    riskClass: "read-only",
    timeoutMs: 15_000,
    description:
      "Read the app's accessibility tree with stable refs, or pass role, name or text to find matching elements. Use before screenshots; act with screen_ui_act.",
  },
  screen_ui_act: {
    title: "Act on app element",
    riskClass: "external-effect",
    timeoutMs: 15_000,
    description:
      "Perform an accessibility action on a ref from screen_ui_tree, or press a menu path. Returns a settled UI snapshot.",
  },
  screen_input: {
    title: "Send app input",
    riskClass: "external-effect",
    timeoutMs: 15_000,
    description:
      "Click, type, paste, press a key or scroll in the app. Prefer screen_ui_act; points are target-window points. Returns a settled UI snapshot.",
  },
  screen_screenshot: {
    title: "Screenshot app",
    riskClass: "read-only",
    timeoutMs: 30_000,
    description:
      "Visual check of the app window. Costs more tokens than screen_ui_tree. Reports the scale between image pixels and input points.",
  },
  screen_measure: {
    title: "Measure app smoothness",
    riskClass: "external-effect",
    timeoutMs: 90_000,
    description:
      "Measure frame timing while observing, or while performing one input action. Returns latency, settle time, FPS and hitch time per second (<5 ms smooth, 5–10 minor, >10 janky) plus a filmstrip. At most 10 s per run and 20 s total.",
  },
};
