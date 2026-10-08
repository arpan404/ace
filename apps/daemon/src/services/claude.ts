import { addClaudeMcp } from "../provider-mcp-add.ts";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import type { ClaudeOptions, ClaudeRateLimitObservation } from "@ace/adapter-claude";
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
export async function daemonClaudeAdapter(
  context: Pick<ServiceContext, "store" | "services" | "id" | "options">,
  cli: DiscoveryResult,
): Promise<ProviderAdapter> {
  const { createClaudeAdapter } = await import("@ace/adapter-claude");
  const { onRateLimit, ...configured } = context.options.claude ?? {};
  const options = { ...configured, ...(cli.path ? { executable: cli.path } : {}) };
  const base = createClaudeAdapter(options);
  return {
    ...base,
    async openSession(ctx) {
      const mcp = context.services.mcp;
      const agentId = context.store.getThread(ctx.threadId)?.rootAgentId;
      if (!mcp || !agentId) throw new Error("Claude MCP scope is unavailable");
      const lease = ctx.aceMcp
        ? {
            bearer: ctx.aceMcp.bearer,
            principal: { signal: ctx.aceMcp.signal ?? ctx.signal },
            end: () => ctx.aceMcp?.end?.(),
          }
        : mcp.openSession(
            {
              sessionId: context.id(),
              threadId: ctx.threadId,
              agentId,
              capabilities: daemonMcpCapabilities(context.services),
            },
            ctx.signal,
          );
      const ace = claudeInjection({
        url: ctx.aceMcp?.url ?? mcp.url,
        bearer: lease.bearer,
      }).mcpServers;
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
        lease?.end();
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
        let dynamic: Record<string, unknown> = { ...options.mcpServers };
        const boundControls: ProviderMcpControl = {
          async add(name, server) {
            if (!cli.path) throw new Error("Claude Code is unavailable");
            await addClaudeMcp(
              ctx.executable ?? cli.path,
              ctx.cwd,
              ctx.env ?? options.env,
              name,
              server,
            );
            dynamic[name] =
              server.transport === "http"
                ? { type: "http", url: server.url }
                : { command: server.command, args: server.args };
            await safe(() => controls.replace({ ...dynamic, ...ace }));
          },
          status: () => safe(async () => stored(await controls.status())),
          // SDK replacements preserve the service-owned ace lease as well as CLI settings/plugins.
          replace: (servers) =>
            safe(async () => {
              const result = await controls.replace({ ...servers, ...ace });
              dynamic = { ...servers };
              return stored(result);
            }),
          reconnect: (name) => safe(() => controls.reconnect(name)),
          enable: (name) => safe(() => controls.enable(name)),
          disable: (name) => safe(() => controls.disable(name)),
        };
        unbind = mcp.providers.bind(
          ctx.threadId,
          "claude",
          boundControls,
          lease?.principal.signal ?? ctx.signal,
        );
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
