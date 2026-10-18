import { z } from "zod";

// Relation properties (aria-describedby, aria-controls) carry related nodes and no value.
const AXValue = z.object({ value: z.unknown().optional() });
/** Lenient: unknown AX fields are ignored, and only what compaction reads is typed. */
export const AXTree = z.object({
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      ignored: z.boolean(),
      backendDOMNodeId: z.number().int().optional(),
      childIds: z.array(z.string()).optional(),
      role: AXValue.optional(),
      name: AXValue.optional(),
      value: AXValue.optional(),
      properties: z.array(z.object({ name: z.string(), value: AXValue.optional() })).optional(),
    }),
  ),
});
export const ResolvedNode = z.object({ object: z.object({ objectId: z.string() }) });
export const CallResult = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.unknown().optional(),
});
export const Bounds = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export const Screencast = z.object({
  sessionId: z.number().int(),
  data: z.string().max(4 * 1024 * 1024),
  metadata: z.object({
    deviceWidth: z.number(),
    deviceHeight: z.number(),
    timestamp: z.number().finite().optional(),
  }),
});
