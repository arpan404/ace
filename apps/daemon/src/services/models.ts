import { createInstance, instanceEnv } from "@ace/accounts";
import { cursorHosts } from "./cursor-hosts.ts";
import { openDaemonModels, registerDefaultModelInstances } from "../models.ts";
import type { ServiceContext } from "./types.ts";
export async function startModels(context: ServiceContext): Promise<void> {
  const { config, options, resources, services } = context;

  const models = openDaemonModels(config.dataDir, options.modelInstances ?? [], {
    ...options.modelDiscovery,
    cursorSlots: cursorHosts(context),
    cursorEnv: options.engine?.cursor?.env ?? process.env,
    cursorEnvironment(instance) {
      if (!instance.homeDir) throw new Error("SDK model catalog needs an instance home");
      const selected =
        services.accountRegistry?.get(instance.id)?.instance ??
        createInstance({
          id: instance.id,
          provider: "cursor",
          label: instance.id,
          homeDir: instance.homeDir,
        });
      if (selected.homeDir !== instance.homeDir || selected.provider !== "cursor")
        throw new Error("SDK catalog instance does not match accounts");
      if (services.cursorAccounts?.isFenced(selected.id))
        throw new Error("SDK catalog is fenced during an account authentication change");
      return instanceEnv(
        selected,
        { ...(options.engine?.cursor?.env ?? process.env), ...instance.env },
        "cursor-sdk",
      );
    },
  });
  resources.own(() => models.close());
  services.models = models;
  const selected = services.accountRegistry?.selectedCursorSdk();
  const account = selected ? services.accountRegistry?.get(selected) : undefined;
  if (account)
    models.registerInstance({
      id: account.instance.id,
      provider: "cursor",
      backend: "cursor-sdk",
      homeDir: account.instance.homeDir,
      cwd: account.instance.homeDir,
      loginRevision: "cursor-sdk-default-v1",
    });
  if (options.modelInstances === undefined) {
    const admission = registerDefaultModelInstances(
      models,
      config.dataDir,
      process.env,
      context.signal,
      new Set(account ? ["cursor"] : []),
    );
    services.modelsReady = admission;
    resources.own(() => admission);
    void admission.catch((error: unknown) =>
      context.log.log("warn", "Default model admission failed", error),
    );
  }
}

import { handleModelRequest } from "../models.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function createModelsSession(context: SocketContext): SocketService {
  const { options, authorize, send, tasks } = context;
  let modelRequests = 0;
  return {
    async handle(message) {
      switch (message.type) {
        case "models.list":
        case "models.resolve":
        case "models.refresh": {
          const modelFailure = (reason: string) =>
            send({
              type: "models.result",
              requestId: message.requestId,
              result: { ok: false, reason },
            });
          const requiredScope = message.type === "models.refresh" ? "operate" : "read";
          if (!authorize(requiredScope)) {
            modelFailure(`${requiredScope} scope required`);
            return true;
          }
          if (!options.models) {
            modelFailure("Model catalog is not configured");
            return true;
          }
          if (modelRequests >= 8) {
            modelFailure("Too many catalog requests");
            return true;
          }
          modelRequests++;
          const task = handleModelRequest(options.models, message)
            .then(send, () => modelFailure("Model catalog request failed"))
            .finally(() => {
              modelRequests--;
            });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          return true;
        }
      }
      return false;
    },
  };
}
