import {
  createClaudeAdapter,
  type ClaudeOptions,
  type ClaudeRateLimitObservation,
} from "@ace/adapter-claude";
import { claudeInjection } from "@ace/mcp-server";
import type { ThreadId } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { ProviderAdapter, ProviderSession } from "@ace/engine-api";
import type { ServiceContext } from "./types.ts";

export interface DaemonClaudeOptions extends Omit<ClaudeOptions, "executable" | "onRateLimit"> {
  /** The accounts owner consumes native metadata; no polling or credential handling here. */
  onRateLimit?(thread: ThreadId, observation: ClaudeRateLimitObservation): void;
}
export function daemonClaudeAdapter(
  context: Pick<ServiceContext, "store" | "services" | "id" | "options">,
  cli: DiscoveryResult,
): ProviderAdapter {
  const { onRateLimit, ...configured } = context.options.claude ?? {};
  const options = { ...configured, ...(cli.path ? { executable: cli.path } : {}) };
  const base = createClaudeAdapter(options);
  return {
    ...base,
    async openSession(ctx) {
      const mcp = context.services.mcp;
      const agentId = context.store.getThread(ctx.threadId)?.rootAgentId;
      if (!mcp || !agentId) throw new Error("Claude MCP scope is unavailable");
      const lease = mcp.openSession(
        {
          sessionId: context.id(),
          threadId: ctx.threadId,
          agentId,
          capabilities: ["agents", "notify"],
        },
        ctx.signal,
      );
      const ace = claudeInjection({ url: mcp.url, bearer: lease.bearer }).mcpServers;
      let session: ProviderSession | undefined;
      let unbind: (() => void) | undefined;
      const end = () => {
        unbind?.();
        lease.end();
      };
      try {
        const adapter = createClaudeAdapter({
          ...options,
          mcpServers: { ...options.mcpServers, ...ace },
          onRateLimit: (observation) => onRateLimit?.(ctx.threadId, observation),
        });
        const opened = await adapter.openSession({
          ...ctx,
          onExit(exit) {
            end();
            ctx.onExit(exit);
          },
        });
        session = opened;
        const controls = opened.mcp;
        if (!controls) throw new Error("Claude MCP controls unavailable");
        unbind = mcp.providers.bind(
          ctx.threadId,
          {
            ...controls,
            // SDK replacements preserve the service-owned ace lease as well as CLI settings/plugins.
            replace: (servers) => controls.replace({ ...servers, ...ace }),
          },
          lease.principal.signal,
        );
        return {
          ...opened,
          async close(reason) {
            try {
              await opened.close(reason);
            } finally {
              end();
            }
          },
        };
      } catch (error) {
        try {
          await session?.close("shutdown");
        } finally {
          end();
        }
        throw error;
      }
    },
  };
}
