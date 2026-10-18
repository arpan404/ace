import { McpNotificationIntent } from "@ace/protocol";
import type { ToolContext, ToolRegistry } from "./registry.ts";
import { builtinToolCatalog } from "./catalog.ts";

export interface McpIntentPort {
  /** Persist the canonical notice and notification intent atomically before returning. */
  notify(intent: McpNotificationIntent, signal: AbortSignal): Promise<{ intentId: string }>;
}
export function registerBuiltins(registry: ToolRegistry, intents: McpIntentPort): void {
  registry.register({
    ...builtinToolCatalog[0],
    async run(notice, context: ToolContext) {
      const result = await intents.notify(
        McpNotificationIntent.parse({ ...context.caller, type: "mcp.notify", notice }),
        context.signal,
      );
      return { ...result, accepted: true as const };
    },
  });
}
