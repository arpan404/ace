import { z } from "zod";
import { McpNotificationIntent, type McpAttribution } from "@ace/protocol";
import type { ToolContext, ToolRegistry } from "./registry.ts";

import { AgentPageInput, AgentPage, builtinToolCatalog } from "./catalog.ts";
export { AgentPageInput, AgentPage } from "./catalog.ts";
export type AgentPageRequest = z.output<typeof AgentPageInput>;
export interface McpReadPort {
  agents(
    caller: McpAttribution,
    page: AgentPageRequest,
    signal: AbortSignal,
  ): Promise<z.input<typeof AgentPage>>;
}
export interface McpIntentPort {
  /** Persist the canonical notice and notification intent atomically before returning. */
  notify(intent: McpNotificationIntent, signal: AbortSignal): Promise<{ intentId: string }>;
}
export function registerBuiltins(
  registry: ToolRegistry,
  reads: McpReadPort,
  intents: McpIntentPort,
): void {
  registry.register({
    ...builtinToolCatalog[0],
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
    ...builtinToolCatalog[1],
    async run(notice, context: ToolContext) {
      const result = await intents.notify(
        McpNotificationIntent.parse({ ...context.caller, type: "mcp.notify", notice }),
        context.signal,
      );
      return { ...result, accepted: true as const };
    },
  });
}
