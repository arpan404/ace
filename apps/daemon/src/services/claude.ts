import {
  createClaudeAdapter,
  type ClaudeOptions,
  type ClaudeRateLimitObservation,
} from "@ace/adapter-claude";
import { createRedactor } from "@ace/redaction";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { claudeInjection } from "@ace/mcp-server";
import type { ThreadId } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { ProviderAdapter, ProviderSession, ProviderMcpControl } from "@ace/engine-api";
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
          capabilities: ["agents", "notify", "browser"],
        },
        ctx.signal,
      );
      const ace = claudeInjection({ url: mcp.url, bearer: lease.bearer }).mcpServers;
      const redact = createRedactor({ env: { ACE_MCP_BEARER_TOKEN: lease.bearer } });
      // Control traffic is cold; redact its credentials without copying stream deltas.
      const stored = (value: unknown): unknown =>
        JSON.parse(redact(JSON.stringify(value) ?? "null"));
      const safe = async <T>(perform: () => Promise<T>): Promise<T> => {
        try {
          return await perform();
        } catch (error) {
          const message = stored(
            error instanceof Error ? error.message : "Claude MCP control failed",
          );
          // oxlint-disable-next-line eslint/preserve-caught-error -- Native causes can contain lease credentials.
          throw new Error(typeof message === "string" ? message : "Claude MCP control failed");
        }
      };
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
          onFrame(frame) {
            if (frame.channel !== "wire") {
              ctx.onFrame(frame);
              return;
            }
            // Admission certifies the redacted bytes, never the original credential-bearing value.
            const payload = new ProviderPayload(redact(JSON.stringify(frame.data) ?? "null"));
            ctx.onFrame({ ...frame, data: payload.data, payload });
          },
          onExit(exit) {
            end();
            ctx.onExit(exit);
          },
        });
        session = opened;
        const controls = opened.mcp;
        if (!controls) throw new Error("Claude MCP controls unavailable");
        const boundControls: ProviderMcpControl = {
          status: () => safe(async () => stored(await controls.status())),
          // SDK replacements preserve the service-owned ace lease as well as CLI settings/plugins.
          replace: (servers) =>
            safe(async () => stored(await controls.replace({ ...servers, ...ace }))),
          reconnect: (name) => safe(() => controls.reconnect(name)),
          enable: (name) => safe(() => controls.enable(name)),
          disable: (name) => safe(() => controls.disable(name)),
        };
        unbind = mcp.providers.bind(ctx.threadId, boundControls, lease.principal.signal);
        return {
          ...opened,
          mcp: boundControls,
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
