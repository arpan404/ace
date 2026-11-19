import { z } from "zod";
import { AgentId, BackgroundTaskId, ItemId, Timestamp } from "./ids.ts";
import { RawPayload } from "./provider-data.ts";

/** Work that can outlive the turn that started it. */
export const BackgroundTask = z.object({
  id: BackgroundTaskId,
  /** Agent that owns the task; its status is `blocked{background_task}` while this runs. */
  agentId: AgentId,
  /** Host-owned execution survives a provider session restarting. */
  owner: z.literal("ace").optional(),
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
  /**
   * ace's own bookkeeping (recovery, correlation, limits) rather than work the agent started.
   * It holds the thread open exactly like running work, but clients never list or name it.
   */
  internal: z.literal(true).optional(),
  /**
   * The provider reported that it never resumes the agent when this task ends (ADR 0109): the
   * agent can't come back for it by itself. Once the agent's turn is over it no longer holds the
   * thread open; it is listed as left running instead.
   */
  wakesAgent: z.literal(false).optional(),
  /**
   * TCP ports the task's processes listen on, as the host last saw them (ADR 0109): a service
   * such as a dev server. Once the agent's turn is over it no longer holds the thread open.
   */
  listening: z.array(z.number().int().min(1).max(65_535)).max(16).optional(),
  /**
   * The provider takes no new prompt while this runs (an ACP shell that outlived its prompt,
   * ADR 0109): it keeps the thread waiting even after the agent's turn finished (ADR 0116).
   */
  blocksPrompts: z.literal(true).optional(),
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
