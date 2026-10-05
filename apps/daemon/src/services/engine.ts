import { logFields, logMetadata } from "@ace/diagnostics";
import { cursorHosts } from "./cursor-hosts.ts";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import { AgentId } from "@ace/protocol";
import { withDaemonMcp } from "./provider-mcp.ts";
import { acpEngineOptions } from "../acp-engine.ts";
import { daemonClaudeAdapter } from "./claude.ts";
import { registerPi } from "./pi.ts";
import { AccountProvider } from "@ace/protocol/accounts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { bindCursorSdk, createInstance } from "@ace/accounts";
import type { ProviderAdapter } from "@ace/engine-api";
import { recoveryPorts, prepareQueuedInput } from "./recovery.ts";
import { Engine } from "../engine/index.ts";
import { discoverAdapters } from "../engine/adapters.ts";
import type { ServiceContext } from "./types.ts";
export async function startEngine(context: ServiceContext): Promise<void> {
  const { config, options, store, resources, services, log } = context;

  if (options.handler) {
    services.handler = options.handler;
    return;
  }
  const engineOptions = options.engine ?? {};
  const defaultInstance = daemonCursorInstance(context);
  const cursorOptions = {
    ...engineOptions.cursor,
    instance: defaultInstance,
    slots: cursorHosts(context),
    mcp:
      engineOptions.cursor?.mcp ??
      (async (
        session: Parameters<
          NonNullable<import("@ace/adapter-cursor").CursorAdapterOptions["mcp"]>
        >[0],
      ) => {
        const mcp = services.mcp;
        const root = store.getThread(session.threadId)?.rootAgentId;
        if (!mcp || !root) throw new Error("Cursor MCP caller is not available");
        const lease = mcp.openSession(
          {
            sessionId: `${session.instanceId}:${session.threadId}`,
            threadId: session.threadId,
            agentId: root,
            capabilities: [],
          },
          session.signal,
        );
        return { connection: { url: mcp.url, bearer: lease.bearer }, end: () => lease.end() };
      }),
  };
  const registry =
    engineOptions.registry ??
    (await discoverAdapters(
      engineOptions.adapterDiscovery,
      (cli) => daemonClaudeAdapter(context, cli),
      (adapters) => registerPi(context, adapters),
      cursorOptions,
    ));
  if (!engineOptions.registry) resources.own(() => registry.close());
  context.signal.throwIfAborted();
  const capabilities = daemonMcpCapabilities(services);
  const acp =
    services.agentRegistry && services.models && services.mcp
      ? acpEngineOptions({
          registry,
          capabilities,
          agents: services.agentRegistry,
          models: services.models,
          mcp: services.mcp,
          store,
          options,
          accounts: services.accounts,
          accountRegistry: services.accountRegistry,
          report: (error) => log.log("error", "ACP metadata failure", error),
        })
      : {};
  const accounts = services.accounts;
  const accountRegistry = services.accountRegistry;
  if (
    accounts &&
    accountRegistry &&
    registry.has("cursor") &&
    registry.get("cursor").adapter.backend === "cursor-sdk" &&
    !accountRegistry.get(defaultInstance.id) &&
    !accountRegistry
      .list()
      .some(({ instance }) => instance.provider === "cursor" && !instance.implicit)
  ) {
    // Preserve the SDK adapter's original home when it first enters accounts ownership.
    await accountRegistry.register(
      createInstance({ ...defaultInstance, provider: "cursor", label: "Cursor SDK" }),
    );
  }
  registry.bindSessions((adapter) => {
    if (!accounts || !accountRegistry || !AccountProvider.safeParse(adapter.provider).success)
      return withDaemonMcp(context, adapter);
    const sdkBinding =
      adapter.backend === "cursor-sdk" ? bindCursorSdk(accounts, cursorOptions) : undefined;
    if (sdkBinding) services.cursorAccounts = sdkBinding;
    const bound: ProviderAdapter & { close?(): Promise<void> } =
      sdkBinding ?? accounts.bindAdapter({ ...adapter, create: (_env, _context) => adapter });
    const wrapped: ProviderAdapter = {
      ...adapter,
      ...(bound.close ? { close: () => bound.close?.() ?? Promise.resolve() } : {}),
      openSession(session) {
        if (
          adapter.backend === "cursor-sdk" &&
          session.instanceId === defaultInstance.id &&
          !accountRegistry.get(session.instanceId)
        )
          return adapter.openSession(session);
        // Listing the normal CLI home must not enroll existing local sessions
        // in registered-account scheduling. Explicit selection still binds it.
        return session.instanceId ||
          accountRegistry.selectedProvider(adapter.provider) ||
          accountRegistry
            .list()
            .some(({ instance }) => instance.provider === adapter.provider && !instance.implicit)
          ? bound.openSession(session)
          : adapter.openSession(session);
      },
    };
    // Cursor SDK owns its read-only HTTP lease, including account identity.
    return adapter.backend === "cursor-sdk" ? wrapped : withDaemonMcp(context, wrapped);
  });
  const ports = recoveryPorts(context, (id) => engine.sessionMetadata(id));
  const aceAction = engineOptions.aceToolAction ?? services.mcp?.action;
  const engine = new Engine(store, {
    ...acp,
    ...engineOptions,
    registry,
    ...(aceAction ? { aceToolAction: aceAction } : {}),
    permissionSettings:
      engineOptions.permissionSettings ??
      (async (id) => {
        const thread = store.getThread(id);
        if (!thread) throw new Error("Thread unavailable");
        const workspace = store.getWorkspace(thread.workspaceId);
        const entry = await services.settings?.get("permissions.defaultMode", {
          thread: id,
          ...(workspace ? { workspace: workspace.path } : {}),
        });
        return entry?.value ?? "auto-review";
      }),
    selectInstance:
      engineOptions.selectInstance ??
      ((_provider, backend) =>
        backend === "cursor-sdk"
          ? (accounts?.preferredCursorInstance() ?? defaultInstance.id)
          : undefined),
    ...(services.workspaceActions
      ? {
          prepareWorkspace: (id) =>
            services.workspaceActions?.prepare(id) ??
            Promise.reject(new Error("Workspace unavailable")),
          machine: services.workspaceActions.machine,
          beforeSend: async (threadId, commandId) => {
            await engineOptions.beforeSend?.(threadId, commandId);
            if (!services.workspaceActions) throw new Error("Workspace unavailable");
            await services.workspaceActions.checkpoints.beforeSend(threadId, commandId);
          },
        }
      : {}),
    mcp:
      engineOptions.mcp ??
      ((threadId, agentId, lifetime) => {
        const mcp = services.mcp;
        if (!mcp) throw new Error("MCP unavailable");
        const lease = mcp.openSession(
          {
            sessionId: context.id(),
            threadId,
            agentId: AgentId.parse(agentId),
            capabilities:
              store.getThread(threadId)?.backend === "cursor-sdk"
                ? []
                : daemonMcpCapabilities(context.services),
          },
          lifetime,
        );
        return {
          url: mcp.url,
          bearer: lease.bearer,
          signal: lease.principal.signal,
          end: lease.end,
        };
      }),
    recovery: engineOptions.recovery ?? ports,
    prepareInput: engineOptions.prepareInput ?? prepareQueuedInput(context),
    ...((engineOptions.transitions ?? services.transitions)
      ? { transitions: engineOptions.transitions ?? services.transitions }
      : {}),
    onProviderDiagnostic:
      engineOptions.onProviderDiagnostic ??
      ((thread, raw) => {
        if (config.logLevel !== "debug") return;
        log.log(
          "debug",
          "Provider diagnostic",
          logFields([
            ["thread", thread],
            ["raw", raw.slice(0, 8).map((payload) => logMetadata(payload))],
          ]),
        );
      }),
    onError: engineOptions.onError ?? ((error) => log.log("error", "Engine failure", error)),
  });
  resources.own(() => engine.close());
  await engine.ready();
  engine.bindHostInteractions((command) => services.browserOrigins?.resolve(command));
  services.engine = engine;
  services.browserOrigins?.recover();
  services.handler = engine.handler;
}

import { commandContext } from "../commands.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function createEngineSession(context: SocketContext): SocketService {
  const { options, send, canReadThread } = context;
  return {
    command: {
      types: [
        "thread.create",
        "thread.prepare",
        "thread.send",
        "thread.interrupt",
        "thread.model.set",
        "thread.mode.set",
        "thread.permission.set",
        "interaction.resolve",
        "background_task.stop",
      ],
      scope: () => "operate",
      async accept(command, device) {
        const payload = command.payload;
        if (
          payload.type === "thread.create" &&
          payload.handoffFrom &&
          !canReadThread(payload.handoffFrom)
        ) {
          send({
            type: "commandResult",
            commandId: command.id,
            ok: false,
            error: "handoff_source_not_found",
          });
          return;
        }
        const receipt = options.store.commandReceipt(command.id, device);
        if (receipt) {
          send({ type: "commandResult", ...receipt });
          return;
        }
        let admission: import("../engine/creation-admissions.ts").CreationAdmission | undefined;
        let preparation: import("../creation-workspace.ts").CreationWorkspace | undefined;
        let accepted = command;
        try {
          await options.engine?.prepareCommand(command);
          if (
            options.engine &&
            (payload.type === "thread.create" || payload.type === "thread.prepare")
          ) {
            const result = options.engine.admitCreation(command);
            if (typeof result === "string") {
              send({ type: "commandResult", commandId: command.id, ok: false, error: result });
              return;
            }
            admission = result;
            accepted = admission.command;
          }
          // An injected handler without the engine admission port keeps its existing late-preparation path.
          if (admission) preparation = await options.workspaceActions?.prepareCreation(accepted);
          if (!context.connected() || !context.authorize("operate")) return;
          if (payload.type === "interaction.resolve") {
            const interaction = options.store.getInteraction(payload.interactionId);
            if (
              interaction?.raw.some((raw) => raw.type === "ace.browser.origin") &&
              !canReadThread(interaction.threadId)
            ) {
              send({
                type: "commandResult",
                commandId: command.id,
                ok: false,
                error: "browser_thread_access_denied",
              });
              return;
            }
          }
          if (
            payload.type === "thread.create" &&
            payload.handoffFrom &&
            !canReadThread(payload.handoffFrom)
          ) {
            send({
              type: "commandResult",
              commandId: command.id,
              ok: false,
              error: "handoff_source_not_found",
            });
            return;
          }
          const result = options.store.recordCommand(command.id, device, () =>
            options.handler.handle(accepted, {
              ...commandContext(options.store),
              ...(admission ? { creationOwner: admission.owner } : {}),
              ...(preparation ? { preparedWorkspace: preparation.workspace } : {}),
            }),
          );
          send({ type: "commandResult", ...result });
        } catch {
          if (context.connected())
            send({
              type: "commandResult",
              commandId: command.id,
              ok: false,
              error: "workspace_unavailable",
            });
        } finally {
          // Release the slot before announcing cleanup completion at the Git boundary.
          admission?.release();
          await preparation?.release();
        }
      },
    },
  };
}
