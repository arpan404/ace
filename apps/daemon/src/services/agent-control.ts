import { createAgentOwners } from "../agent-control/owners.ts";
import { DelegationService } from "../agent-control/delegations.ts";
import { createAgentControlPort } from "../agent-control/tools.ts";
import { systemClock } from "../engine/actor.ts";
import type { ServiceContext } from "./types.ts";

export function startAgentControl(context: ServiceContext): void {
  const { services, store, options, now, id, log, resources, onListen } = context;
  const engine = services.engine;
  if (!engine) return;
  let maintenance: { admit(): boolean } | undefined;
  onListen.push((server) => {
    maintenance = server.maintenance;
  });
  const delegations = new DelegationService({
    store,
    engine,
    clock: options.engine?.clock ?? { ...systemClock, now },
    id,
    ...(services.accountRegistry ? { accounts: services.accountRegistry } : {}),
    ...(options.agentControl?.policy ? { policy: options.agentControl.policy } : {}),
    admitsWork: () => maintenance?.admit() ?? false,
    onError: (error) => log.log("error", "Agent control failure", error),
  });
  resources.own(() => delegations.close());
  resources.onShutdown(() => delegations.close());
  const owners = createAgentOwners(context, delegations);
  const port = createAgentControlPort(store, delegations, {
    ...options.agentControl?.extensions,
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
  services.agentControl = { delegations, port, previews: owners.previews };
  // Drain accepted legacy spawn intents through the same child creation receipts.
  onListen.push(() => {
    for (const entry of store.readMcpIntents(100)) {
      if (entry.intent.type !== "mcp.spawn") continue;
      const intent = entry.intent;
      const parent = store.getThread(intent.threadId);
      if (!parent) continue;
      try {
        store.atomic(() => {
          delegations.delegate(intent, {
            requestId: entry.id,
            provider: intent.input.provider ?? parent.provider,
            role: intent.input.name ?? "delegate",
            task: intent.input.task,
            wait: false,
            estimatedLoad: 0,
          });
          store.acknowledgeMcpIntent(entry.id);
        });
      } catch (error) {
        log.log("warn", "Legacy spawn remains pending until admission is available", error);
      }
    }
  });
}
