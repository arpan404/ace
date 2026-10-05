import { discoverCursorSdk } from "@ace/adapter-cursor";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { createInstance, instanceEnv } from "@ace/accounts";
import { cursorHosts } from "./cursor-hosts.ts";
import {
  openDaemonModels,
  registerDefaultModelInstances,
  registerConfiguredModelInstances,
} from "../models.ts";
import type { ServiceContext } from "./types.ts";
export async function startModels(context: ServiceContext): Promise<void> {
  const { config, options, resources, services } = context;

  const models = openDaemonModels(
    config.dataDir,
    options.modelInstances ?? [],
    {
      ...(options.engine?.cursor?.discovery
        ? { cursorDiscovery: options.engine.cursor.discovery }
        : {}),
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
    },
    () => context.services.providerConfigurations?.current() ?? [],
  );
  const stopConfiguration = context.services.providerConfigurations?.listen(() => {
    models.configurationChanged();
    if (options.modelInstances === undefined)
      registerConfiguredModelInstances(
        models,
        config.dataDir,
        services.providerConfigurations?.current() ?? [],
      );
  });
  if (stopConfiguration) resources.own(stopConfiguration);
  resources.own(() => models.close());
  services.models = models;
  const selected = services.accountRegistry?.selectedCursorSdk();
  const account = selected ? services.accountRegistry?.get(selected) : undefined;
  const sdk =
    context.services.providerConfigurations?.for("cursor").enabled === false ||
    account ||
    options.modelInstances !== undefined
      ? undefined
      : await discoverCursorSdk(options.engine?.cursor?.discovery);
  const privateSdkConfigured =
    options.engine?.cursor?.instance !== undefined || config.cursorSdkHome !== undefined;
  const sdkInstance =
    account?.instance ??
    (options.modelInstances === undefined && (sdk?.installed || privateSdkConfigured)
      ? daemonCursorInstance(context)
      : undefined);
  if (sdkInstance)
    models.registerInstance({
      id: sdkInstance.id,
      provider: "cursor",
      backend: "cursor-sdk",
      homeDir: sdkInstance.homeDir,
      cwd: sdkInstance.homeDir,
      loginRevision: "cursor-sdk-default-v1",
    });
  if (options.modelInstances === undefined) {
    registerConfiguredModelInstances(
      models,
      config.dataDir,
      services.providerConfigurations?.current() ?? [],
    );
    const admission = registerDefaultModelInstances(
      models,
      config.dataDir,
      process.env,
      context.signal,
      new Set(sdkInstance ? ["cursor"] : []),
      services.providerConfigurations?.current() ?? [],
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
          const catalog = options.models;
          if (modelRequests >= 8) {
            modelFailure("Too many catalog requests");
            return true;
          }
          modelRequests++;
          const request =
            message.type === "models.refresh"
              ? Promise.resolve(options.providerActivation).then(() =>
                  handleModelRequest(catalog, message),
                )
              : handleModelRequest(catalog, message);
          const task = request
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
