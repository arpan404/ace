import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import { AgentId } from "@ace/protocol";
import { withDaemonMcp } from "./provider-mcp.ts";
import { acpEngineOptions } from "../acp-engine.ts";
import { daemonClaudeAdapter } from "./claude.ts";
import { registerPi } from "./pi.ts";
import { AccountProvider } from "@ace/protocol/accounts";
import { recoveryPorts, prepareQueuedInput } from "./recovery.ts";
import { Engine } from "../engine/index.ts";
import { discoverAdapters } from "../engine/adapters.ts";
import type { ServiceContext } from "./types.ts";
export async function startEngine(context: ServiceContext): Promise<void> {
  const { options, store, resources, services, log } = context;

  if (options.handler) {
    services.handler = options.handler;
    return;
  }
  const engineOptions = options.engine ?? {};
  const registry =
    engineOptions.registry ??
    (await discoverAdapters(
      engineOptions.adapterDiscovery,
      (cli) => daemonClaudeAdapter(context, cli),
      (adapters) => registerPi(context, adapters),
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
  registry.bindSessions((adapter) => {
    if (!accounts || !accountRegistry || !AccountProvider.safeParse(adapter.provider).success)
      return withDaemonMcp(context, adapter);
    const bound = accounts.bindAdapter({ ...adapter, create: (_env, _context) => adapter });
    return withDaemonMcp(context, {
      ...adapter,
      openSession(session) {
        return session.instanceId ||
          accountRegistry.list().some(({ instance }) => instance.provider === adapter.provider)
          ? bound.openSession(session)
          : adapter.openSession(session);
      },
    });
  });
  const ports = recoveryPorts(context, (id) => engine.sessionMetadata(id));
  const engine = new Engine(store, {
    ...acp,
    ...engineOptions,
    registry,
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
            capabilities: daemonMcpCapabilities(context.services),
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
    onError: engineOptions.onError ?? ((error) => log.log("error", "Engine failure", error)),
  });
  resources.own(() => engine.close());
  await engine.ready();
  services.engine = engine;
  services.handler = engine.handler;
}

import { commandContext } from "../commands.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function createEngineSession(context: SocketContext): SocketService {
  const { options, send } = context;
  return {
    command: {
      types: [
        "thread.create",
        "thread.prepare",
        "thread.send",
        "thread.interrupt",
        "thread.model.set",
        "thread.mode.set",
        "interaction.resolve",
        "background_task.stop",
      ],
      scope: () => "operate",
      async accept(command, device) {
        await options.engine?.prepareCommand(command);
        if (!context.connected() || !context.authorize("operate")) return;
        const result = options.store.recordCommand(command.id, device, () =>
          options.handler.handle(command, commandContext(options.store)),
        );
        send({ type: "commandResult", ...result });
      },
    },
  };
}
