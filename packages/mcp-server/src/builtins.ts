import { z } from "zod";
import {
  Agent,
  Thread,
  McpNoticeInput,
  McpNotificationIntent,
  McpSpawnInput,
  McpSpawnIntent,
  type McpAttribution,
} from "@ace/protocol";
import type { ToolContext, ToolRegistry } from "./registry.ts";

const accepted = z.strictObject({
  intentId: z.string().min(1).max(256),
  accepted: z.literal(true),
});
export const AgentPageInput = z.strictObject({
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const AgentPage = z.strictObject({
  agents: z.array(Agent).max(100),
  nextCursor: z.string().max(256).nullable(),
});
export type AgentPageRequest = z.output<typeof AgentPageInput>;
export interface McpReadPort {
  thread(caller: McpAttribution, signal: AbortSignal): Promise<z.input<typeof Thread>>;
  agents(
    caller: McpAttribution,
    page: AgentPageRequest,
    signal: AbortSignal,
  ): Promise<z.input<typeof AgentPage>>;
}
export interface McpIntentPort {
  /** Persist the canonical notice and notification intent atomically before returning. */
  notify(intent: McpNotificationIntent, signal: AbortSignal): Promise<{ intentId: string }>;
  /** Persist an orchestration intent; the consumer owns creating and running the child. */
  spawn(intent: McpSpawnIntent, signal: AbortSignal): Promise<{ intentId: string }>;
}
export function registerBuiltins(
  registry: ToolRegistry,
  reads: McpReadPort,
  intents: McpIntentPort,
): void {
  registry.register({
    name: "ace_thread_info",
    description: "Read this thread and its canonical status.",
    input: z.strictObject({}),
    output: z.strictObject({ thread: Thread }),
    capability: null,
    timeoutMs: 10_000,
    async run(_, { caller, signal }) {
      const thread = Thread.parse(await reads.thread(caller, signal));
      if (thread.id !== caller.threadId) throw new Error("Thread scope mismatch");
      return { thread };
    },
  });
  registry.register({
    name: "ace_list_agents",
    description: "Read a page of this thread's agent tree; status includes live descendants.",
    input: AgentPageInput,
    output: AgentPage,
    capability: null,
    timeoutMs: 10_000,
    async run(page, { caller, signal }) {
      const result = AgentPage.parse(await reads.agents(caller, page, signal));
      if (
        result.agents.length > page.limit ||
        result.agents.some((agent) => agent.threadId !== caller.threadId)
      )
        throw new Error("Agent scope mismatch");
      return result;
    },
  });
  registry.register({
    name: "ace_notify_user",
    description: "Post a notice and request a user notification.",
    input: McpNoticeInput,
    output: accepted,
    capability: "notify",
    timeoutMs: 10_000,
    async run(notice, context: ToolContext) {
      const result = await intents.notify(
        McpNotificationIntent.parse({ ...context.caller, type: "mcp.notify", notice }),
        context.signal,
      );
      return { ...result, accepted: true as const };
    },
  });
  registry.register({
    name: "ace_spawn_agent",
    description:
      "Request a child agent. Acceptance is not completion; inspect the tree for progress.",
    input: McpSpawnInput,
    output: accepted,
    capability: "agents",
    timeoutMs: 10_000,
    async run(input, context: ToolContext) {
      const result = await intents.spawn(
        McpSpawnIntent.parse({ ...context.caller, type: "mcp.spawn", input }),
        context.signal,
      );
      return { ...result, accepted: true as const };
    },
  });
}
