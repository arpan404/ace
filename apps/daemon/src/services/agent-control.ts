import { logError } from "@ace/diagnostics";
import { agentControlCall } from "./agent-control-failure.ts";
import { AgentControlError } from "../agent-control/failure.ts";
import { createAgentOwners } from "../agent-control/owners.ts";
import { DelegationService } from "../agent-control/delegations.ts";
import { createAgentControlPort } from "../agent-control/tools.ts";
import { systemClock } from "../engine/actor.ts";
import type { ServiceContext } from "./types.ts";
import { createWorkspaceDelegations } from "../agent-control/workspaces.ts";
import { createConversationStarts } from "../agent-control/conversations.ts";

export function startAgentControl(context: ServiceContext): void {
  const { services, store, options, now, id, log, resources, onListen } = context;
  const engine = services.engine;
  if (!engine || !services.models) return;
  let maintenance: { admit(): boolean } | undefined;
  onListen.push((server) => {
    maintenance = server.maintenance;
  });
  const delegations = new DelegationService({
    store,
    engine,
    clock: options.engine?.clock ?? { ...systemClock, now },
    id,
    models: services.models,
    providerEnabled: (provider, instance) =>
      services.providerConfigurations?.for(provider, instance).enabled !== false,
    ...(services.modelsReady ? { modelsReady: services.modelsReady } : {}),
    async configuredModel(caller, request) {
      const settings = services.settings;
      if (!settings) return undefined;
      const role = /review/i.test(request.role)
        ? "reviewer"
        : /plan/i.test(request.role)
          ? "planner"
          : "coder";
      const thread = store.getThread(caller.threadId);
      const workspace = thread ? store.getWorkspace(thread.workspaceId) : undefined;
      const scope = {
        thread: caller.threadId,
        ...(workspace ? { workspace: workspace.path } : {}),
      };
      const roles = ["coder", "reviewer", "planner"] as const;
      const candidates: (typeof roles)[number][] = [role, ...roles.filter((r) => r !== role)];
      for (const candidate of candidates) {
        const provider = await settings.get(`providers.${candidate}.provider`, scope);
        if (provider.value !== request.provider) continue;
        const model = await settings.get(`providers.${candidate}.model`, scope);
        if (model.value !== "default") return model.value;
      }
      return undefined;
    },
    ...(services.accountRegistry ? { accounts: services.accountRegistry } : {}),
    ...(options.agentControl?.policy ? { policy: options.agentControl.policy } : {}),
    admitsWork: () => maintenance?.admit() ?? false,
    onError: (error) => log.log("error", "Agent control failure", logError(error)),
  });
  resources.own(() => delegations.close());
  resources.onShutdown(() => delegations.close());
  const owners = createAgentOwners(context, delegations);
  const port = createAgentControlPort(store, delegations, {
    ...options.agentControl?.extensions,
    delegateWorkspace: createWorkspaceDelegations(context, delegations),
    // Machine calls start after this service; each call reads the live owner.
    machines: {
      list: async (caller) =>
        services.machines
          ? services.machines.caller.list(caller)
          : { ok: false, code: "unsupported" },
      delegate: async (caller, request, signal) => {
        const machines = services.machines;
        if (!machines) throw new AgentControlError("machine_unavailable", "machines_not_ready");
        return machines.caller.delegate(caller, request, signal);
      },
      owns: (caller, child) => services.machines?.children.owns(caller, child) ?? false,
      status: (child) => services.machines?.children.watched(child)?.view,
      cancel: async (child) =>
        services.machines
          ? services.machines.caller.cancel(child)
          : { ok: false, code: "not_found" },
    },
    startConversation: createConversationStarts(context, delegations, delegations.conversations),
    pr: async (caller, operation, signal) => {
      const workspace = services.workspaceActions;
      if (!workspace) return { ok: false, code: "unsupported" };
      return workspace.forge.agent(
        caller.threadId,
        workspace.root(caller.threadId),
        operation,
        signal,
      );
    },
    execute: async (caller, operation, signal) => {
      const result = await owners.execute(caller, operation, signal);
      return result.code === "unsupported" && options.agentControl?.extensions?.execute
        ? options.agentControl.extensions.execute(caller, operation, signal)
        : result;
    },
    ...(services.notifications
      ? {
          snooze: (thread, until) =>
            services.notifications?.snooze(thread, until ?? 0) ?? Promise.resolve(),
        }
      : {}),
  });
  services.agentControl = {
    delegations,
    port: {
      execute: (caller, operation, signal) =>
        agentControlCall(context, caller, operation.op, signal, () =>
          port.execute(caller, operation, signal),
        ),
    },
    previews: owners.previews,
  };
}
