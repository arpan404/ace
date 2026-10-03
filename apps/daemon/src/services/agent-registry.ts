import { join } from "node:path";
import {
  AgentCatalog,
  AgentRegistry,
  fileCache,
  fileInventoryStorage,
  platformTarget,
} from "@ace/agent-registry";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startAgentRegistry(context: ServiceContext): Promise<void> {
  const { config, resources, now, id, options, services } = context;
  const root = join(config.dataDir, "agent-registry");
  const target = platformTarget(process.platform, process.arch) ?? "unsupported";
  const catalog = await AgentCatalog.open({
    cache: fileCache(join(root, "registry.json"), id),
    now,
    target,
  });
  resources.own(() => catalog.close());
  const registry = await AgentRegistry.open({
    catalog,
    root: join(root, "installations"),
    target,
    storage: fileInventoryStorage(join(root, "inventory.json"), id),
    env: process.env,
    ...(options.acpManagers ? { managers: options.acpManagers } : {}),
  });
  resources.own(() => registry.close());
  for (const binding of options.acpBindings ?? []) {
    if (!registry.has(binding)) await registry.bind(binding);
  }
  services.agentRegistry = registry;
}
export function createAgentRegistrySession(context: SocketContext): SocketService {
  const { options, authorize, send, tasks } = context;
  let pending = 0;
  return {
    async handle(message) {
      if (!message.type.startsWith("registry.")) return false;
      if (
        ![
          "registry.bind",
          "registry.list",
          "registry.refresh",
          "registry.install-plan",
          "registry.install-intent",
          "registry.install-cancel",
        ].includes(message.type)
      )
        return false;
      const request = importRequest(message);
      if (!request) return false;
      const failure = (reason: string) =>
        send({
          type: "registry.result",
          requestId: request.requestId,
          result: { ok: false, reason },
        });
      const scope =
        request.type === "registry.list"
          ? "read"
          : request.type === "registry.refresh"
            ? "operate"
            : "admin";
      if (!authorize(scope)) {
        failure(`${scope} scope required`);
        return true;
      }
      if (scope === "admin" && !authorize("operate")) {
        failure("operate scope required");
        return true;
      }
      if (!options.agentRegistry) {
        failure("Agent registry unavailable");
        return true;
      }
      if (pending >= 8 || tasks.size >= 16) {
        failure("Too many registry requests");
        return true;
      }
      pending++;
      const task = options.agentRegistry
        .handle(request)
        .then(
          (result) => {
            if (!context.connected()) return;
            if (!authorize(scope) || (scope === "admin" && !authorize("operate"))) return;
            if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
              failure("Registry reply exceeds wire limit");
            else send(result);
          },
          () => failure("Registry request failed"),
        )
        .finally(() => {
          pending--;
        });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return true;
    },
  };
}
import { RegistryRequest } from "@ace/protocol";
function importRequest(value: unknown): RegistryRequest | undefined {
  const parsed = RegistryRequest.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
