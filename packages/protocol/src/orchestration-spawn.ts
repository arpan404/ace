import { z } from "zod";
import { LaneSpec, OrchestrationId } from "./orchestration.ts";
/** MCP arguments deliberately exclude parent identity; the host supplies it from the session. */
export const SpawnAgentRequest = z.strictObject({
  requestId: OrchestrationId,
  spec: LaneSpec,
  prompt: z.string().min(1).max(32768),
});
export type SpawnAgentRequest = z.infer<typeof SpawnAgentRequest>;
