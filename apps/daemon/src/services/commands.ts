import { AccountProvider } from "@ace/protocol/accounts";
import { pickInstance } from "@ace/accounts";
import { createDaemonCommandLibrary, defaultCommandInstances } from "../command-library.ts";
import { connectDaemonCommandEvents, type CommandEventSource } from "../command-events.ts";
import type { ProviderInstance } from "@ace/commands";
import { join } from "node:path";
import type { Thread } from "@ace/protocol";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export interface DaemonCommandIntegration {
  instances?: readonly ProviderInstance[];
  instanceForThread?: (thread: Thread) => string;
  events?: CommandEventSource;
}
export async function startCommands({
  store,
  config,
  options,
  resources,
  services,
  now,
}: ServiceContext) {
  const integration = options.commands ?? {};
  const registered = services.accountRegistry?.list() ?? [];
  const library = createDaemonCommandLibrary(
    store,
    config.dataDir,
    integration.instances ??
      (registered.length
        ? [
            ...defaultCommandInstances(process.env).filter(
              (instance) =>
                !registered.some((account) => account.instance.provider === instance.provider),
            ),
            ...registered.map(({ instance }) => ({
              id: instance.id,
              provider: instance.provider,
              home:
                instance.provider === "opencode"
                  ? join(instance.env.XDG_CONFIG_HOME ?? instance.homeDir, "opencode")
                  : instance.homeDir,
            })),
          ]
        : undefined),
    process.env,
    integration.instanceForThread ??
      ((thread) => {
        const row = services.engine
          ? store.atomic((db) =>
              db
                .prepare("SELECT instance_id FROM engine_sessions WHERE thread_id=?")
                .get(thread.id),
            )
          : undefined;
        if (typeof row?.instance_id === "string") return row.instance_id;
        const provider = AccountProvider.safeParse(thread.provider);
        const selected = provider.success
          ? pickInstance(
              { provider: provider.data, role: "worker", estimatedLoad: 1 },
              registered,
              now(),
            )
          : undefined;
        return selected?.id ?? thread.provider;
      }),
  );
  resources.own(() => library.close());
  if (integration.events) {
    const disconnect = connectDaemonCommandEvents(library, integration.events);
    resources.onShutdown(disconnect);
  }
  services.commands = library;
}
export function createCommandsSession(context: SocketContext): SocketService {
  return {
    async handle(message) {
      if (message.type !== "commands.list" && message.type !== "commands.resolve") return false;
      const readable = () =>
        context.connected() && context.authorize("read") && context.canReadThread(message.threadId);
      if (!context.authorize("read")) context.fail("forbidden", "Read scope required");
      else if (
        !context.options.store.getThread(message.threadId) ||
        !context.canReadThread(message.threadId)
      )
        context.fail("read_denied", "Thread is not readable");
      else if (!context.options.commands)
        context.fail("commands_unavailable", "Command catalog unavailable");
      else
        try {
          if (message.type === "commands.list") {
            const result = await context.options.commands.list(
              message.threadId,
              message.query,
              message.limit,
            );
            if (readable())
              context.send({
                type: "commands.list.result",
                requestId: message.requestId,
                ...result,
              });
          } else {
            const result = await context.options.commands.resolve(
              message.threadId,
              message.commandId,
              message.arguments,
              message.positional,
            );
            if (readable())
              context.send({
                type: "commands.resolve.result",
                requestId: message.requestId,
                result,
              });
          }
        } catch {
          context.fail("commands_failed", "Unknown thread or command catalog unavailable");
        }
      return true;
    },
  };
}
