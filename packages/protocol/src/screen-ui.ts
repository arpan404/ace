import { z } from "zod";
import { ScreenUINode } from "./screen-v2.ts";
export {
  ScreenRect as ScreenUIBounds,
  ScreenUIAction,
  ScreenUITreeOptions,
  ScreenUIFindOptions,
  ScreenUIActOptions,
  ScreenUINode,
  ScreenUIFindResult,
  ScreenUIActResult,
} from "./screen-v2.ts";
export const ScreenUITree = z.object({ root: ScreenUINode.nullable(), truncated: z.boolean() });
export const ScreenAgentScope = z.object({
  threadId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
});
export type ScreenAgentScope = z.infer<typeof ScreenAgentScope>;
