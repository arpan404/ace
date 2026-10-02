import { z } from "zod";
import { AgentId, BackgroundTaskId, ItemId, Timestamp } from "./ids.ts";
import { RawPayload } from "./provider.ts";

/** Work that can outlive the turn that started it. */
export const BackgroundTask = z.object({
  id: BackgroundTaskId,
  /** Agent that owns the task; its status is `blocked{background_task}` while this runs. */
  agentId: AgentId,
  kind: z.enum(["shell", "monitor", "subagent", "other"]),
  title: z.string(),
  status: z.enum(["running", "completed", "failed", "stopped", "unknown"]),
  /** Tool call that started it. */
  toolCallId: ItemId.optional(),
  /** For `subagent` tasks: the agent doing the work. */
  childAgentId: AgentId.optional(),
  /** Whether ace can stop it individually (see Capabilities.backgroundTaskControl). */
  stoppable: z.boolean(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  raw: z.array(RawPayload).default([]),
});
export type BackgroundTask = z.infer<typeof BackgroundTask>;
