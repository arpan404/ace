import { RemotePublications } from "../agent-control/remote-publication.ts";
import { RemoteReturns } from "../agent-control/remote-return.ts";
import { prepareRemoteContext } from "../agent-control/remote-context-source.ts";
import { loadHostId } from "../local-files.ts";
import { RemoteDelegations } from "../agent-control/remote.ts";
import { logError } from "@ace/diagnostics";
import { agentControlCall } from "./agent-control-failure.ts";
import { createAgentOwners } from "../agent-control/owners.ts";
import { DelegationService } from "../agent-control/delegations.ts";
import { createAgentControlPort } from "../agent-control/tools.ts";
import { systemClock } from "../engine/actor.ts";
import type { ServiceContext } from "./types.ts";

export function startAgentControl(context: ServiceContext): void {
  const { services, store, options, now, id, log, resources, onListen } = context;
  const engine = services.engine;
  if (!engine || !services.models) return;
  let maintenance: { admit(): boolean } | undefined;
  onListen.push((server) => {
    maintenance = server.maintenance;
  });
  let remote: RemoteDelegations | undefined;
  const delegations = new DelegationService({
    externalCapacity: (parent, root) => ({
      concurrent:
        remote?.journal.active().filter((task) => task.parentThreadId === parent).length ?? 0,
      children: remote?.journal.root(root).children ?? 0,
      usage: remote?.journal.root(root).usage ?? { tokens: 0, cost: 0 },
    }),
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
  const returns = new RemoteReturns(store);
  let returnCleanup: ReturnType<typeof setInterval> | undefined;
  const cleanReturns = () =>
    services.context
      ? returns.cleanup(services.context, (error) =>
          log.log("warn", "Cancelled output cleanup", logError(error)),
        )
      : Promise.resolve();
  onListen.push(() => {
    void cleanReturns();
    returnCleanup = setInterval(() => {
      void cleanReturns();
    }, 60_000);
    returnCleanup.unref();
  });
  resources.own(async () => {
    if (returnCleanup) clearInterval(returnCleanup);
    await cleanReturns();
  });

  const publications = new RemotePublications({
    store,
    engine,
    context: services.context,
    files: services.threadFiles,
    hostId: loadHostId(context.config.dataDir),
  });
  remote = new RemoteDelegations({
    resolveArtifacts: async (task) => {
      const ownedContext = services.context;
      if (!ownedContext) throw new Error("Returned attachment context unavailable");
      return Promise.all(
        (task.artifacts?.attachments ?? []).map(async (file) => {
          const owned = await ownedContext.uploads.attachment(
            "ace-remote-agent",
            task.parentThreadId,
            file.sha256,
          );
          return {
            sha256: file.sha256,
            name: owned.attachment.name,
            path: owned.path,
            hostId: task.sourceHostId,
            threadId: task.parentThreadId,
            provenance: {
              hostId: task.request.hostId,
              threadId: task.threadId,
              name: file.name,
              sourcePath: file.sourcePath,
              aliases: file.aliases,
            },
          };
        }),
      );
    },
    onReturnCancel: (task) =>
      returns.abandon(task, services.context, (error) =>
        log.log("warn", "Cancelled output cleanup", logError(error)),
      ),
    pendingArtifacts: (task) => returns.read(task.id)?.artifacts,
    artifactReady: (task, artifacts) => returns.ready(task, artifacts),
    clock: options.engine?.clock ?? { ...systemClock, now },
    onError: (error) => log.log("error", "Remote delegation failure", logError(error)),
    prepareContext: (task, signal) =>
      prepareRemoteContext(
        { store, context: services.context, files: services.threadFiles },
        task,
        signal,
      ),
    hostId: loadHostId(context.config.dataDir),
    store,
    engine,
    local: delegations,
    now,
    id,
    admit: () => maintenance?.admit() ?? false,
  });
  resources.own(() => remote?.close());
  resources.onShutdown(() => remote?.close());
  delegations.onRemoteCancel = (thread) => remote?.cancelTree(thread);
  const owners = createAgentOwners(context, delegations);
  const port = createAgentControlPort(store, delegations, {
    ...options.agentControl?.extensions,
    remote: (caller, operation, signal) =>
      (operation.op === "device.task_publish"
        ? publications.publish(caller, operation, signal)
        : remote?.execute(caller, operation, signal)) ??
      Promise.resolve({ ok: false, code: "not_ready" as const }),
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
    returns,
    publications,
    remote,
    delegations,
    port: {
      execute: (caller, operation, signal) =>
        agentControlCall(context, caller, operation.op, signal, () =>
          port.execute(caller, operation, signal),
        ),
    },
    previews: owners.previews,
  };
  // Drain accepted legacy spawn intents through the same child creation receipts.
  onListen.push(async () => {
    for (const entry of store.readMcpIntents(100)) {
      if (entry.intent.type !== "mcp.spawn") continue;
      const intent = entry.intent;
      const parent = store.getThread(intent.threadId);
      if (!parent) continue;
      try {
        const request = {
          requestId: entry.id,
          provider: intent.input.provider ?? parent.provider,
          role: intent.input.name ?? "delegate",
          task: intent.input.task,
          wait: false,
          estimatedLoad: 0,
        };
        const model = await delegations.prepareModels(intent, request);
        context.signal.throwIfAborted();
        store.atomic(() => {
          delegations.delegate(intent, request, model);
          store.acknowledgeMcpIntent(entry.id);
        });
      } catch (error) {
        log.log(
          "warn",
          "Legacy spawn remains pending until admission is available",
          logError(error),
        );
      }
    }
  });
}
