import { z } from "zod";
import { AgentId, BackgroundTaskId, ItemId, Timestamp } from "./ids.ts";
import { RawPayload } from "./provider-data.ts";

/** Work that can outlive the turn that started it. */
export const BackgroundTask = z.object({
  id: BackgroundTaskId,
  /** Agent that owns the task; its status is `blocked{background_task}` while this runs. */
  agentId: AgentId,
  kind: z.enum(["shell", "monitor", "subagent", "other"]),
  title: z.string(),
  /**
   * `unknown`: ace lost track (provider restarted, no end event). Treated as
   * not running for thread "done", and shown to the user as possibly running.
   */
  status: z.enum(["running", "completed", "failed", "stopped", "unknown"]),
  /**
   * Long-lived helper the provider keeps around (e.g. watchers) that should
   * never hold a thread open.
   */
  ambient: z.boolean().default(false),
  /** File the provider writes the task's output to, if any. */
  outputPath: z.string().optional(),
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
