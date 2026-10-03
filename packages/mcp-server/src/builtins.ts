import { z } from "zod";
import { Thread, McpNotificationIntent, McpSpawnIntent, type McpAttribution } from "@ace/protocol";
import type { ToolContext, ToolRegistry } from "./registry.ts";

import { AgentPageInput, AgentPage, builtinToolCatalog } from "./catalog.ts";
export { AgentPageInput, AgentPage } from "./catalog.ts";
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
    ...builtinToolCatalog[0],
    async run(_, { caller, signal }) {
      const thread = Thread.parse(await reads.thread(caller, signal));
      if (thread.id !== caller.threadId) throw new Error("Thread scope mismatch");
      return { thread };
    },
  });
  registry.register({
    ...builtinToolCatalog[1],
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
    ...builtinToolCatalog[2],
    async run(notice, context: ToolContext) {
      const result = await intents.notify(
        McpNotificationIntent.parse({ ...context.caller, type: "mcp.notify", notice }),
        context.signal,
      );
      return { ...result, accepted: true as const };
    },
  });
  registry.register({
    ...builtinToolCatalog[3],
    async run(input, context: ToolContext) {
      const result = await intents.spawn(
        McpSpawnIntent.parse({ ...context.caller, type: "mcp.spawn", input }),
        context.signal,
      );
      return { ...result, accepted: true as const };
    },
  });
}
