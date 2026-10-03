import { z } from "zod";

export const ScreenEndpoint = z
  .string()
  .max(256)
  .refine(
    (value) =>
      /^unix:\/[^\0\r\n]+$/.test(value) ||
      /^pipe:\\\\\.\\pipe\\ace-screen-[a-zA-Z0-9_-]+$/.test(value),
    "Expected an absolute unix: endpoint or an ace-screen named pipe",
  );
export const ScreenError = z.object({
  code: z.enum([
    "permission_denied",
    "target_gone",
    "not_supported",
    "bounds",
    "busy",
    "timeout",
    "internal",
  ]),
  message: z.string().max(1024),
});
export const ScreenCapabilities = z.object({
  version: z.literal(2),
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
    .array(z.enum(["press", "focus", "setValue", "scroll", "expand", "select"]))
    .max(6),
  codecs: z
    .array(z.enum(["jpeg", "h264"]))
    .min(1)
    .max(2),
  permissions: z.object({
    screen: z.enum(["granted", "denied", "prompt", "n/a"]),
    input: z.enum(["granted", "denied", "prompt", "n/a"]),
  }),
});
export type ScreenCapabilities = z.infer<typeof ScreenCapabilities>;
export const ScreenRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
});
export const ScreenUIAction = z.enum(["press", "focus", "setValue", "scroll", "expand", "select"]);
export const ScreenUIRef = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const ScreenUINode = z.object({
  ref: ScreenUIRef,
  role: z.string().max(128),
  name: z.string().max(256),
  value: z.string().max(512).optional(),
  description: z.string().max(256).optional(),
  bounds: ScreenRect,
  states: z
    .array(z.enum(["focused", "selected", "checked", "disabled", "expanded", "offscreen"]))
    .max(6),
  actions: z.array(ScreenUIAction).max(6),
  get children(): z.ZodArray<typeof ScreenUINode> {
    return z.array(ScreenUINode).max(512);
  },
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
  value: z.string().max(4096).optional(),
});
// Check the total budget iteratively before the recursive decoder sees external data.
function boundedNodes(roots: number) {
  return z
    .array(z.unknown())
    .max(roots)
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
    .pipe(z.array(ScreenUINode).max(roots));
}
export const ScreenUITreeResult = z.object({
  nodes: boundedNodes(512),
  truncated: z.boolean(),
});
export const ScreenUIFindResult = z.object({
  nodes: boundedNodes(64),
  truncated: z.boolean(),
});
export const ScreenUIActResult = z.object({ fallback: z.boolean() });
export type ScreenUITreeResult = z.infer<typeof ScreenUITreeResult>;
export type ScreenUIFindResult = z.infer<typeof ScreenUIFindResult>;
export type ScreenUIActOptions = z.infer<typeof ScreenUIActOptions>;
const point = { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() };
const modifiers = z
  .array(z.enum(["command", "shift", "option", "control"]))
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
]);
export type ScreenInput = z.infer<typeof ScreenInput>;
