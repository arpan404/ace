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

const sessionId = ScreenId.optional().describe("Omit with one app.");
const windowId = z.number().int().positive();
const coordinate = z.number().finite().nonnegative();
const delta = z.number().int().min(-1000).max(1000);
/**
 * Exactly the names `ScreenKey` accepts, as one pattern: models read it instead of a 174-entry
 * enum, and decoding still checks the enum.
 */
export const screenKeyPattern =
  /^(?:[!-~]|[Ff](?:[1-9]|1\d|20)|[Ee](?:nter|sc(?:ape)?|nd)|[Rr](?:eturn|ight)|[Tt]ab|[Ss]pace|[Bb]ackspace|[Dd](?:elete|own)|[Hh]ome|[Ll]eft|[Uu]p|Page(?:Up|Down)|page(?:up|down)|Arrow(?:Left|Right|Up|Down)|arrow(?:left|right|up|down))$/;
const toolKey = z.string().regex(screenKeyPattern).pipe(ScreenKey);
const [click, drag, keyPress, typed, scrolled, pasted] = ScreenMeasurementAction.options;
const MeasuredAction = z.discriminatedUnion("kind", [
  click,
  drag,
  keyPress.extend({ key: toolKey }),
  typed,
  scrolled,
  pasted,
]);

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
    .describe("click: x,y; button. type, paste: text. key: key; modifiers. scroll: dx,dy; x,y."),
  x: coordinate.optional().describe("Window point: screenshot pixel / scale."),
  y: coordinate.optional(),
  button: z.enum(["left", "right"]).optional(),
  text: z.string().max(4096).optional(),
  key: toolKey.optional(),
  modifiers: ScreenKeyModifiers.unwrap().optional(),
  dx: delta.optional(),
  dy: delta.optional().describe("Positive scrolls down."),
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
  ref: ScreenUIRef.optional(),
  action: ScreenUIAction.optional(),
  name: ScreenUIActOptions.shape.name.describe("For performSecondaryAction."),
  range: ScreenUIActOptions.shape.range,
  value: ScreenUIActOptions.shape.value.describe("For setValue or scroll."),
  menu: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(8)
    .optional()
    .describe('Instead of ref, e.g. ["File","New Window"].'),
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
  role: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(256).optional(),
  text: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(64).default(16).describe("Find only."),
  maxDepth: z.number().int().min(0).max(16).default(8).describe("Tree only."),
  maxNodes: z.number().int().min(1).max(512).default(128).describe("Tree only."),
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
    bundleId: ScreenBundle.describe("e.g. com.apple.TextEdit."),
    windowId: windowId.optional().describe("From screen_windows."),
    url: ScreenAppURL.optional().describe("A deep link."),
    mode: z
      .enum(["background", "foreground"])
      .optional()
      .describe("foreground takes the real cursor and keyboard."),
  }),
  screen_windows: z.strictObject({ bundleId: ScreenBundle }),
  screen_ui_tree: z.strictObject({ sessionId, ...uiReadShape }),
  screen_ui_act: ScreenUIActArgs,
  screen_input: ScreenInputArgs,
  screen_screenshot: z.strictObject({ sessionId }),
  screen_measure: z.strictObject({
    sessionId,
    action: MeasuredAction.optional().describe("Omit to observe only."),
    observeMs: z.number().int().min(1).max(10_000).default(2000).describe("Per run."),
    repeat: z.number().int().min(1).max(5).default(1),
    filmstrip: z.boolean().default(true),
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
      "Launch or rejoin a macOS app in a background session the person can watch; returns sessionId and windows.",
  },
  screen_windows: {
    title: "List app windows",
    riskClass: "read-only",
    timeoutMs: 15_000,
    description: "List an app's windows, with windowIds for screen_open_app.",
  },
  screen_ui_tree: {
    title: "Read app UI",
    riskClass: "read-only",
    timeoutMs: 15_000,
    description:
      "Read the app's accessibility tree with refs, or find elements by role, name or text.",
  },
  screen_ui_act: {
    title: "Act on app element",
    riskClass: "external-effect",
    timeoutMs: 15_000,
    description:
      "Do an accessibility action on a screen_ui_tree ref, or press a menu path. Returns the settled UI.",
  },
  screen_input: {
    title: "Send app input",
    riskClass: "external-effect",
    timeoutMs: 15_000,
    description:
      "Click, type, paste, press a key or scroll in the app; prefer screen_ui_act. Returns the settled UI.",
  },
  screen_screenshot: {
    title: "Screenshot app",
    riskClass: "read-only",
    timeoutMs: 30_000,
    description:
      "Picture of the app window; costlier than screen_ui_tree. Reports its scale to input points.",
  },
  screen_measure: {
    title: "Measure app smoothness",
    riskClass: "external-effect",
    timeoutMs: 90_000,
    description:
      "Measure frame timing while observing or during one input action. Hitch ms per second: under 5 smooth, over 10 janky. At most 20 s in all.",
  },
};
