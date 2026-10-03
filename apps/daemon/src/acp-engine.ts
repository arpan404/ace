import { createAcpAdapter, genericQuirks } from "@ace/adapter-acp";
import { digest, type AgentRegistry, type LaunchPlan } from "@ace/agent-registry";
import type { ModelCatalog, InstanceInput } from "@ace/models";
import { AcpIdentity } from "@ace/protocol";
import { acpInjection, acpStdioInjection } from "@ace/mcp-server";
import type { EngineOptions, AdapterRegistry } from "./engine/index.ts";
import type { Services } from "./services/types.ts";
import type { DaemonOptions } from "./services/options.ts";
import type { Store } from "./store.ts";
export function acpEngineOptions(input: {
  registry: AdapterRegistry;
  agents: AgentRegistry;
  models: ModelCatalog;
  mcp: Services["mcp"];
  store: Store;
  options: DaemonOptions;
  report(error: unknown): void;
}): Pick<EngineOptions, "sessionContext"> {
  const launches = new WeakMap<AbortSignal, LaunchPlan>();
  input.registry.register(
    createAcpAdapter(genericQuirks, {
      acceptsIdentity: (identity) => input.agents.has(identity),
      async resolveLaunch(ctx) {
        const plan = launches.get(ctx.signal);
        if (!plan) throw new Error("ACP immutable launch plan unavailable");
        return plan;
      },
    }),
    { installed: true, auth: "unknown", loginHint: "Use the agent's own CLI login" },
  );
  return {
    async sessionContext(threadId, signal) {
      const thread = input.store.getThread(threadId);
      if (thread?.provider !== "acp") return {};
      const identity = AcpIdentity.parse(thread);
      const account = input.options.acpEnvironment?.(identity) ?? {
        env: process.env,
        loginRevision: "default-local",
      };
      const plan = await input.agents.resolve(identity, account.env);
      launches.set(signal, plan);
      const root = thread.rootAgentId;
      if (!root) throw new Error("ACP MCP caller unavailable");
      const lease = input.mcp.openSession(
        {
          sessionId: `${threadId}:${identity.installationId}`,
          threadId,
          agentId: root,
          capabilities: ["notify", "agents"],
        },
        signal,
      );
      const connection = { url: input.mcp.url, bearer: lease.bearer };
      const instance: InstanceInput = {
        id: `acp-${digest(JSON.stringify(identity))}`,
        provider: "acp",
        ...identity,
        loginRevision: account.loginRevision,
        executable: plan.command,
        cwd: input.store.atomic((db) =>
          String(
            db.prepare("SELECT cwd FROM engine_sessions WHERE thread_id=?").get(threadId)?.cwd ??
              "",
          ),
        ),
        args: [...plan.args],
        env: Object.fromEntries(
          Object.entries(plan.env).filter(
            (pair): pair is [string, string] => pair[1] !== undefined,
          ),
        ),
        profileRevision: plan.profile?.revision ?? "generic-v1",
        installationVersion: plan.version,
      };
      try {
        input.models.registerInstance(instance);
      } catch (error) {
        lease.end();
        throw error;
      }
      let metadataPending: { value: unknown } | undefined;
      let metadataFlight = false;
      const drainMetadata = async () => {
        if (metadataFlight) return;
        metadataFlight = true;
        try {
          while (metadataPending && !signal.aborted) {
            const value = metadataPending.value;
            metadataPending = undefined;
            try {
              await input.models.updateFromSession(instance, value);
            } catch (error) {
              input.report(error);
            }
          }
        } finally {
          metadataPending = undefined;
          metadataFlight = false;
        }
      };
      return {
        env: account.env,
        mcp: {
          httpServers: acpInjection(connection).mcpServers,
          stdioServers: acpStdioInjection(connection).mcpServers,
          configuredServers: input.options.acpMcpServers ?? [],
          secrets: [lease.bearer],
          end: lease.end,
        },
        onSessionMetadata(metadata) {
          if (signal.aborted) return;
          metadataPending = { value: metadata };
          void drainMetadata();
        },
      };
    },
  };
}
