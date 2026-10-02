import { z } from "zod";
export const ScreenUIBounds = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
});
export const ScreenUIAction = z.enum(["press", "focus", "setValue", "scroll", "expand", "select"]);
export const ScreenUITreeOptions = z.object({
  maxDepth: z.number().int().min(0).max(32).default(8),
  maxNodes: z.number().int().min(1).max(2048).default(256),
});
export const ScreenUIFindOptions = z.object({
  query: z.object({
    role: z.string().max(256).optional(),
    name: z.string().max(256).optional(),
    text: z.string().max(256).optional(),
  }),
  limit: z.number().int().min(1).max(128).default(20),
});
export const ScreenUIActOptions = z.object({
  ref: z.string().min(1).max(128),
  action: ScreenUIAction,
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
export const ScreenUINode = z.object({
  ref: z.string().max(128),
  role: z.string().max(64),
  name: z.string().max(256),
  value: z.string().max(256).optional(),
  description: z.string().max(256).optional(),
  bounds: ScreenUIBounds,
  states: z
    .array(z.enum(["focused", "selected", "checked", "disabled", "expanded", "offscreen"]))
    .max(6),
  actions: z.array(ScreenUIAction).max(6),
  get children(): z.ZodArray<typeof ScreenUINode> {
    return z.array(ScreenUINode).max(2048);
  },
});
export const ScreenUITree = z.object({ root: ScreenUINode.nullable(), truncated: z.boolean() });
export const ScreenUIFindResult = z.object({
  nodes: z.array(ScreenUINode).max(128),
  truncated: z.boolean(),
});
export const ScreenUIActResult = z.object({
  fallback: z.boolean(),
  method: z.literal("input").optional(),
  boundsCentre: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
});

export const ScreenAgentScope = z.object({
  threadId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
});
export type ScreenAgentScope = z.infer<typeof ScreenAgentScope>;
