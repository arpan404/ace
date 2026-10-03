import { daemonClaudeAdapter } from "./claude.ts";
import { AccountProvider } from "@ace/protocol/accounts";
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
    (await discoverAdapters(engineOptions.adapterDiscovery, (cli) =>
      daemonClaudeAdapter(context, cli),
    ));
  if (!engineOptions.registry) resources.own(() => registry.close());
  const accounts = services.accounts;
  const accountRegistry = services.accountRegistry;
  if (accounts && accountRegistry)
    registry.bindSessions((adapter) => {
      if (!AccountProvider.safeParse(adapter.provider).success) return adapter;
      const bound = accounts.bindAdapter({ ...adapter, create: (_env, _context) => adapter });
      return {
        ...adapter,
        openSession(session) {
          return session.instanceId ||
            accountRegistry.list().some(({ instance }) => instance.provider === adapter.provider)
            ? bound.openSession(session)
            : adapter.openSession(session);
        },
      };
    });
  const engine = new Engine(store, {
    ...engineOptions,
    registry,
    ...((engineOptions.transitions ?? services.transitions)
      ? { transitions: engineOptions.transitions ?? services.transitions }
      : {}),
    onError: engineOptions.onError ?? ((error) => log.log("error", "Engine failure", error)),
  });
  resources.own(() => engine.close());
  services.engine = engine;
  services.handler = engine.handler;
}

import { commandContext } from "../commands.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function createEngineSession({ options, send }: SocketContext): SocketService {
  return {
    command: {
      types: [
        "thread.create",
        "thread.send",
        "thread.interrupt",
        "thread.archive",
        "interaction.resolve",
        "background_task.stop",
      ],
      scope: () => "operate",
      accept(command, device) {
        const result = options.store.recordCommand(command.id, device, () =>
          options.handler.handle(command, commandContext(options.store)),
        );
        send({ type: "commandResult", ...result });
      },
    },
  };
}
