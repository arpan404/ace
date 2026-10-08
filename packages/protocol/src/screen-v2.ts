import { ScreenId, ScreenTarget, ScreenAction, ScreenBundle } from "./screen-base.ts";
import { z } from "zod";

export const ScreenEndpoint = z
  .string()
  .max(256)
  .regex(/^(?:unix:\/[^\0\r\n]+|pipe:\\\\\.\\pipe\\ace-screen-[a-zA-Z0-9_-]+)$/)
  .meta({
    "x-ace-constraint": "Absolute unix: path without NUL, CR or LF, or an ace-screen named pipe.",
    examples: ["unix:/example/frames.sock"],
  });
export const ScreenError = z.object({
  code: z.enum([
    "forbidden",
    "permission_denied",
    "approval_required",
    "screen_disabled",
    "denied",
    "read_only",
    "target_gone",
    "not_supported",
    "bounds",
    "busy",
    "timeout",
    "internal",
    "target_busy",
    "foreground_required",
    "focus_changed",
    "window_minimized",
    "window_offscreen",
    "secure_input_required",
    "clipboard_changed",
    "window_ambiguous",
    "key_unsupported",
    "modifier_unsupported",
    "no_key_window",
    "delivery_unconfirmed",
  ]),
  message: z.string().max(1024),
  phase: z.enum(["rejected-before-dispatch", "dispatched", "partial"]).optional(),
  candidates: z
    .array(
      z.object({
        windowId: z.number().int().nonnegative(),
        title: z.string().max(256),
        bounds: z.object({
          x: z.number().finite(),
          y: z.number().finite(),
          w: z.number().finite(),
          h: z.number().finite(),
        }),
      }),
    )
    .max(128)
    .optional(),
});
export type ScreenError = z.infer<typeof ScreenError>;
export const ScreenCapabilities = z
  .object({
    version: z.literal(2),
    background: z.boolean().optional(),
    maxSessions: z.number().int().min(1).max(8).optional(),
    platform: z.enum(["macos", "windows", "linux-x11", "linux-wayland"]),
    capture: z.object({ windows: z.boolean(), displays: z.boolean(), changeDriven: z.boolean() }),
    input: z.object({
      pointer: z.boolean(),
      keyboard: z.boolean(),
      scroll: z.boolean(),
      text: z.boolean(),
    }),
    uiTree: z.boolean(),
    semanticActions: z
      .array(
        z.enum([
          "press",
          "focus",
          "setValue",
          "scroll",
          "expand",
          "select",
          "performSecondaryAction",
          "selectText",
        ]),
      )
      .max(8),
    codecs: z
      .array(z.enum(["jpeg", "h264"]))
      .min(1)
      .max(2),
    permissions: z.object({
      screen: z.enum(["granted", "denied", "prompt", "n/a"]),
      input: z.enum(["granted", "denied", "prompt", "n/a"]),
    }),
  })
  .passthrough();
export type ScreenCapabilities = z.infer<typeof ScreenCapabilities>;
export const ScreenRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
});
export const ScreenUIAction = z.enum([
  "press",
  "focus",
  "setValue",
  "scroll",
  "expand",
  "select",
  "performSecondaryAction",
  "selectText",
]);
export const ScreenUIRef = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const ScreenUINode = z
  .object({
    ref: ScreenUIRef,
    role: z.string().max(128),
    name: z.string().max(256),
    value: z.string().max(512).optional(),
    secondaryActions: z.array(z.string().max(256)).max(32).optional(),
    description: z.string().max(256).optional(),
    bounds: ScreenRect,
    states: z
      .array(z.enum(["focused", "selected", "checked", "disabled", "expanded", "offscreen"]))
      .max(6),
    actions: z.array(ScreenUIAction).max(8),
    get children(): z.ZodArray<typeof ScreenUINode> {
      return z.array(ScreenUINode).max(512);
    },
  })
  .meta({
    examples: [
      {
        ref: "example",
        role: "button",
        name: "Example",
        bounds: { x: 0, y: 0, w: 10, h: 10 },
        states: [],
        actions: ["press"],
        children: [],
      },
    ],
  });
export const ScreenUITreeOptions = z.object({
  maxDepth: z.number().int().min(0).max(16).default(8),
  maxNodes: z.number().int().min(1).max(512).default(128),
});
const UIQueryFields = z.object({
  role: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(256).optional(),
  text: z.string().min(1).max(512).optional(),
});
export const ScreenUIQuery = z.union([
  UIQueryFields.extend({ role: z.string().min(1).max(128) }),
  UIQueryFields.extend({ name: z.string().min(1).max(256) }),
  UIQueryFields.extend({ text: z.string().min(1).max(512) }),
]);
export const ScreenUIFindOptions = z.object({
  query: ScreenUIQuery,
  limit: z.number().int().min(1).max(64).default(16),
});
export const ScreenUIActOptions = z.object({
  ref: ScreenUIRef,
  action: ScreenUIAction,
  name: z.string().min(1).max(256).optional(),
  range: z
    .object({ location: z.number().int().nonnegative(), length: z.number().int().nonnegative() })
    .optional(),
  value: z
    .union([
      z.string().max(4096),
      z.boolean(),
      z.object({
        dx: z.number().int().min(-1000).max(1000).default(0),
        dy: z.number().int().min(-1000).max(1000).default(0),
      }),
    ])
    .optional(),
});
// Check the total budget iteratively before the recursive decoder sees external data.
function boundedNodes(roots: number) {
  return z
    .array(z.unknown())
    .max(roots, { message: "UI tree exceeds root budget" })
    .superRefine((nodes, context) => {
      const pending = nodes.map((node) => ({ node, depth: 0 }));
      const shape = z.object({ children: z.array(z.unknown()).max(512) });
      let count = 0;
      while (pending.length) {
        const item = pending.pop();
        if (!item) break;
        if (++count > 512 || item.depth > 16) {
          context.addIssue({
            code: "custom",
            message: "UI tree exceeds total node or depth budget",
          });
          return;
        }
        const result = shape.safeParse(item.node);
        if (!result.success || pending.length + result.data.children.length > 512) {
          context.addIssue({ code: "custom", message: "Invalid or oversized UI children" });
          return;
        }
        for (const node of result.data.children) pending.push({ node, depth: item.depth + 1 });
      }
    })
    .pipe(z.array(ScreenUINode).max(roots))
    .meta({
      "x-ace-json-input": z.array(ScreenUINode).max(roots),
      "x-ace-constraint":
        "At most 512 total UI nodes and depth 16, checked before recursive decoding.",
    });
}
export const ScreenUITreeResult = z.object({
  nodes: boundedNodes(512),
  truncated: z.boolean(),
});
export const ScreenUIFindResult = z.object({
  nodes: boundedNodes(64),
  truncated: z.boolean(),
});
export const ScreenUIActResult = z.object({
  fallback: z.boolean(),
  mode: z.enum(["background", "foreground"]).optional(),
  snapshot: ScreenUITreeResult.optional(),
  warnings: z.array(z.string().max(1024)).max(8).optional(),
  phase: z.enum(["rejected-before-dispatch", "dispatched", "partial"]).optional(),
  method: z.string().max(64).optional(),
  boundsCentre: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
});
export type ScreenUITreeResult = z.infer<typeof ScreenUITreeResult>;
export type ScreenUIFindResult = z.infer<typeof ScreenUIFindResult>;
export type ScreenUIActOptions = z.infer<typeof ScreenUIActOptions>;
const point = { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() };
const modifiers = z
  .array(z.enum(["command", "shift", "option", "control", "alt", "meta", "super"]))
  .max(4)
  .default([]);
export const ScreenInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pointer.move"), ...point }),
  z.object({
    kind: z.literal("pointer.click"),
    ...point,
    button: z.enum(["left", "right"]).default("left"),
  }),
  z.object({
    kind: z.literal("pointer.drag"),
    durationMs: z.number().int().min(1).max(10000).optional(),
    ...point,
    toX: z.number().finite().nonnegative(),
    toY: z.number().finite().nonnegative(),
    button: z.enum(["left", "right"]).default("left"),
  }),
  z.object({ kind: z.literal("key.press"), key: z.string().min(1).max(32), modifiers }),
  z.object({ kind: z.literal("text.type"), text: z.string().max(4096) }),
  z.object({
    kind: z.literal("scroll"),
    x: point.x.optional(),
    y: point.y.optional(),
    dx: z.number().int().min(-1000).max(1000),
    dy: z.number().int().min(-1000).max(1000),
  }),
  z.object({ kind: z.literal("text.paste"), text: z.string().max(4096) }),
  z.object({ kind: z.literal("pointer.down"), ...point }),
  z.object({ kind: z.literal("pointer.up"), ...point }),
  z.object({ kind: z.literal("pointer.cancel") }),
]);
export type ScreenInput = z.infer<typeof ScreenInput>;

export const ScreenFrameHeaderV2 = z.object({
  version: z.literal(2),
  sessionId: ScreenId,
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ts: z.number().finite().nonnegative(),
  width: z.number().int().min(1).max(3840),
  height: z.number().int().min(1).max(2160),
  scale: z.number().finite().positive(),
  captureGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  codec: z.literal("jpeg"),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
  dirtyRects: z.array(ScreenRect).max(32).optional(),
});
const Envelope = z.object({ version: z.literal(2), id: ScreenId });
export const ScreenHelperRequestV2 = z.discriminatedUnion("op", [
  Envelope.extend({ op: z.literal("hello") }),
  Envelope.extend({ op: z.literal("permissions") }),
  Envelope.extend({ op: z.literal("targets") }),
  Envelope.extend({
    op: z.literal("open.url"),
    bundleId: ScreenBundle,
    allowlist: z.array(ScreenBundle).max(64),
    url: z.string().min(1).max(8192),
  }),
  Envelope.extend({
    op: z.literal("menu.press"),
    path: z.array(z.string().min(1).max(256)).min(1).max(8),
    target: ScreenTarget.optional(),
    allowlist: z.array(ScreenBundle).max(64).optional(),
  }),
  Envelope.extend({ op: z.literal("stop") }),
  Envelope.extend({
    op: z.literal("start"),
    sessionId: ScreenId,
    captureGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    target: ScreenTarget,
    allowlist: z.array(z.string().min(1).max(256)).max(64),
    fps: z.number().int().min(1).max(30),
  }),
  Envelope.extend({ op: z.literal("action"), action: ScreenAction }),
  Envelope.extend({
    op: z.literal("watch"),
    active: z.boolean(),
    captureGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  Envelope.extend({
    op: z.literal("ui.tree"),
    target: ScreenTarget.optional(),
    allowlist: z.array(ScreenBundle).max(64),
    ...ScreenUITreeOptions.shape,
  }),
  Envelope.extend({
    op: z.literal("ui.find"),
    target: ScreenTarget.optional(),
    allowlist: z.array(ScreenBundle).max(64).optional(),
    ...ScreenUIFindOptions.shape,
  }),
  Envelope.extend({
    op: z.literal("ui.act"),
    target: ScreenTarget.optional(),
    allowlist: z.array(ScreenBundle).max(64).optional(),
    ...ScreenUIActOptions.shape,
  }),
  Envelope.extend({
    op: z.literal("pointer.move"),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
  }),
  Envelope.extend({
    op: z.literal("pointer.click"),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z.enum(["left", "right"]).default("left"),
  }),
  Envelope.extend({
    op: z.literal("pointer.drag"),
    durationMs: z.number().int().min(1).max(10000).optional(),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    toX: z.number().finite().nonnegative(),
    toY: z.number().finite().nonnegative(),
    button: z.enum(["left", "right"]).default("left"),
  }),
  Envelope.extend({
    op: z.literal("key.press"),
    key: z.string().min(1).max(64),
    modifiers: z
      .array(z.enum(["control", "shift", "alt", "meta", "super"]))
      .max(4)
      .default([]),
  }),
  Envelope.extend({ op: z.literal("text.type"), text: z.string().max(4096) }),
  Envelope.extend({
    op: z.literal("scroll"),
    dx: z.number().int().min(-1000).max(1000),
    dy: z.number().int().min(-1000).max(1000),
  }),
]);
export type ScreenHelperRequestV2 = z.infer<typeof ScreenHelperRequestV2>;
export const ScreenHelperReplyV2 = Envelope.extend({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: ScreenError.optional(),
}).passthrough();

export const ScreenHelperError = ScreenError;
export const ScreenPermissionsV2 = z.object({
  screen: z.enum(["granted", "denied", "prompt", "n/a"]),
  input: z.enum(["granted", "denied", "prompt", "n/a"]),
});

export const ScreenUITreeInput = ScreenUITreeOptions;
export const ScreenUIFindInput = ScreenUIFindOptions;
export const ScreenUIActInput = ScreenUIActOptions;
export const ScreenNamedKey = z.object({
  key: z.string().min(1).max(64),
  modifiers: z
    .array(z.enum(["control", "shift", "alt", "meta", "super", "command", "option"]))
    .max(4)
    .default([]),
});
export const ScreenTransportFrameHeader = z.union([ScreenFrameHeaderV2]);
export type ScreenTransportFrameHeader = z.infer<typeof ScreenTransportFrameHeader>;
