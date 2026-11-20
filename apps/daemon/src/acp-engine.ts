import { daemonMcpCapabilities } from "./services/mcp-capabilities.ts";
import { createAcpAdapter, genericQuirks } from "@ace/adapter-acp";
import { acpModelInstanceId } from "./acp-model-instance.ts";
import {
  acpAgentCli,
  geminiTrustEnv,
  geminiWorkspaceTrust,
  readGeminiTrustFacts,
  type AgentRegistry,
} from "@ace/agent-registry";
import type { ModelCatalog, InstanceInput } from "@ace/models";
import { AcpIdentity, type McpCapability } from "@ace/protocol";
import {
  acpInjection,
  acpStdioInjection,
  acpClaudeToolListing,
  acpShowsServerInstructions,
  acpToolListing,
  geminiUntrustedGuidance,
} from "@ace/mcp-server";
import { claudeToolSearchFacts } from "@ace/adapter-claude/tool-search";
import type { EngineOptions, AdapterRegistry } from "./engine/index.ts";
import type { Services } from "./services/types.ts";
import type { DaemonOptions } from "./services/options.ts";
import { createAcpInstance } from "@ace/accounts";
import { homedir } from "node:os";
import type { Store } from "./store.ts";
export function acpEngineOptions(input: {
  registry: AdapterRegistry;
  agents: AgentRegistry;
  models: ModelCatalog;
  mcp: Services["mcp"];
  store: Store;
  options: DaemonOptions;
  accounts?: Services["accounts"];
  accountRegistry?: Services["accountRegistry"];
  userHome?: string;
  capabilities?: McpCapability[];
  /** The checkout a worktree ace created was made from; undefined for any other folder. */
  worktreeSource?: (path: string) => string | undefined;
  report(error: unknown): void;
}): Pick<EngineOptions, "sessionContext" | "sessionCatalog"> {
  input.registry.register(
    createAcpAdapter(genericQuirks, {
      acceptsIdentity: (identity) => input.agents.has(identity),
      signInMethod: (ctx) =>
        ctx.acpIdentity
          ? input.accountRegistry?.acpSignInMethod(ctx.acpIdentity.instanceId)
          : undefined,
      async resolveLaunch(ctx) {
        const plan = ctx.acpLaunch;
        if (!plan) throw new Error("ACP immutable launch plan unavailable");
        return plan;
      },
    }),
    { installed: true, auth: "unknown", loginHint: "Use the agent's own CLI login" },
  );
  const accountFor = (identity: AcpIdentity) =>
    input.options.acpEnvironment?.(identity) ??
    input.accounts?.acpEnvironment(identity) ?? {
      env: process.env,
      loginRevision: "default-local",
    };
  return {
    /**
     * A generic agent's catalog row exists before its model is chosen: after a restart the row is
     * otherwise unknown until a session opens, and a thread's chosen model reads as unavailable.
     * Only the thread opening now is registered, so startup does no work per stored thread.
     */
    async sessionCatalog(threadId) {
      const thread = input.store.getThread(threadId);
      if (thread?.provider !== "acp") return;
      const identity = AcpIdentity.parse(thread);
      const id = acpModelInstanceId(identity);
      if (input.models.list({ instance: id }).instances.length) return;
      const account = accountFor(identity);
      const plan = await input.agents.resolve(identity, account.env);
      const cwd = input.store.atomic((db) =>
        String(
          db.prepare("SELECT cwd FROM engine_sessions WHERE thread_id=?").get(threadId)?.cwd ?? "",
        ),
      );
      if (input.models.list({ instance: id }).instances.length) return;
      input.models.registerInstance(catalogInstance(identity, account.loginRevision, plan, cwd));
    },
    async sessionContext(threadId, signal) {
      const thread = input.store.getThread(threadId);
      if (thread?.provider !== "acp") return {};
      const identity = AcpIdentity.parse(thread);
      if (
        input.accounts &&
        input.accountRegistry &&
        !input.accountRegistry.get(identity.instanceId)
      ) {
        const installation = input.agents.inventory
          .list()
          .find(
            (entry) =>
              entry.installationId === identity.installationId &&
              entry.acpAgentId === identity.acpAgentId &&
              entry.instanceId === identity.instanceId,
          );
        if (!installation) throw new Error("Approved ACP installation unavailable");
        await input.accountRegistry.register(
          createAcpInstance({
            identity,
            label: identity.acpAgentId.slice(0, 128),
            userHome: input.userHome ?? homedir(),
            installation,
          }),
        );
      }
      const account = accountFor(identity);
      const resolved = await input.agents.resolve(identity, account.env);
      const root = thread.rootAgentId;
      if (!root) throw new Error("ACP MCP caller unavailable");
      const { cwd, model } = input.store.atomic((db) => {
        const row = db
          .prepare("SELECT cwd,model FROM engine_sessions WHERE thread_id=?")
          .get(threadId);
        return {
          cwd: String(row?.cwd ?? ""),
          model: typeof row?.model === "string" ? row.model : undefined,
        };
      });
      // Each agent lists what its own tool refresh supports: Gemini CLI reloads, the Claude
      // Agent SDK and Antigravity defer, and the rest keep a fixed list. claude-agent-acp runs
      // Claude Code, which defers only while its tool search is on: the thread's model, the
      // launch env and settings decide.
      const cli = acpAgentCli(identity.acpAgentId);
      // Gemini CLI loads no MCP server, and refuses full access, in a folder it does not trust.
      // A worktree ace made from a checkout the person trusts gets that trust for this process;
      // any other untrusted folder fails with instructions for the person to grant trust.
      const trust =
        cli === "gemini"
          ? geminiWorkspaceTrust(
              await readGeminiTrustFacts({
                env: resolved.env,
                userHome: input.userHome ?? homedir(),
                platform: process.platform,
                cwd,
                source: input.worktreeSource?.(cwd),
              }),
            )
          : undefined;
      if (trust?.state === "untrusted") throw new Error(geminiUntrustedGuidance(cwd, trust.denied));
      const plan =
        trust?.state === "inherited"
          ? { ...resolved, env: { ...resolved.env, [geminiTrustEnv]: "true" } }
          : resolved;
      const listing =
        cli === "claude-acp"
          ? acpClaudeToolListing(
              await claudeToolSearchFacts({
                env: plan.env,
                cwd,
                sources: ["user", "project", "local"],
                model,
              }),
            )
          : acpToolListing(cli);
      const lease = input.mcp.openSession(
        {
          sessionId: `${threadId}:${identity.installationId}`,
          threadId,
          agentId: root,
          capabilities: input.capabilities ?? daemonMcpCapabilities({}),
        },
        signal,
      );
      // Agents that never show MCP server instructions (Antigravity files them away) get ace's
      // guidance in their own channel instead.
      const connection = {
        url: input.mcp.url,
        bearer: lease.bearer,
        listing,
        serverInstructions: acpShowsServerInstructions(cli),
        session: lease.session,
      };
      const instance = catalogInstance(identity, account.loginRevision, plan, cwd);
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
      // Rendered once here, where the agent's listing is known, so its guidance stays stable.
      const injected = acpInjection(connection, cli === "antigravity" ? "antigravity" : "acp");
      return {
        acpLaunch: plan,
        env: account.env,
        mcp: {
          httpServers: injected.mcpServers,
          stdioServers: acpStdioInjection(connection).mcpServers,
          configuredServers: input.options.acpMcpServers ?? [],
          secrets: [lease.bearer],
          instructions: injected.developerInstructions,
          end: lease.end,
        },
        onSessionMetadata(metadata) {
          if (signal.aborted) return;
          metadataPending = { value: metadata };
          void drainMetadata().catch((error: unknown) => input.report(error));
        },
      };
    },
  };
}

/** The catalog row of a generic ACP agent's account, as its sessions report into it. */
function catalogInstance(
  identity: AcpIdentity,
  loginRevision: string,
  plan: Awaited<ReturnType<AgentRegistry["resolve"]>>,
  cwd: string,
): InstanceInput {
  return {
    id: acpModelInstanceId(identity),
    provider: "acp",
    ...identity,
    loginRevision,
    executable: plan.command,
    cwd,
    args: [...plan.args],
    // Generic ACP never uses catalog-driven process discovery. Keep the launch
    // environment only on its daemon-local plan, outside model metadata.
    env: {},
    profileRevision: plan.profile?.revision ?? "generic-v1",
    installationVersion: plan.version,
  };
}
