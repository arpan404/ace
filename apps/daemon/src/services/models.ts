import { ProviderKind } from "@ace/protocol";
import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { cursorInstanceHome } from "@ace/adapter-cursor/instance";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { logError, logFields } from "@ace/diagnostics";
import { discoverCursorSdk } from "@ace/adapter-cursor/discovery";
import { cursorSdkCatalogInstance, registerCursorSdkCatalog } from "./cursor-activation.ts";
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

  const instances = [];
  for (const row of options.modelInstances ?? []) {
    if (row.provider !== "cursor" || row.backend === "cursor-sdk") {
      instances.push(row);
      continue;
    }
    const id = cursorInstanceId(row.id) ?? row.id;
    const instance =
      row.id === "cursor-cli-default"
        ? await daemonCursorInstance(context)
        : (services.accountRegistry?.get(id)?.instance ?? {
            id,
            homeDir: cursorInstanceHome(config.dataDir, id),
          });
    instances.push({
      id: instance.id,
      label: row.label,
      provider: "cursor" as const,
      backend: "cursor-sdk" as const,
      homeDir: instance.homeDir,
      cwd: row.cwd,
      loginRevision: row.loginRevision,
    });
  }
  const models = openDaemonModels(
    config.dataDir,
    instances,
    {
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
          throw Object.assign(new Error("Sign in to Cursor"), { code: "not_configured" });
        return instanceEnv(
          selected,
          { ...(options.engine?.cursor?.env ?? process.env), ...instance.env },
          "cursor-sdk",
        );
      },
    },
    () => context.services.providerConfigurations?.current() ?? [],
    (provider, instance, error, source, diagnostic) =>
      context.log.log(
        diagnostic?.level ?? "warn",
        diagnostic?.modelIndex !== undefined
          ? "Model metadata entry rejected"
          : error.code === "not_configured"
            ? "Provider sign-in is required"
            : error.code === "no_models"
              ? "Connected source has no chat models enabled"
              : "Model discovery failed",
        logFields([
          ["provider", provider],
          ["instance", instance],
          ["source", source ?? null],
          ["sourceLabel", diagnostic?.sourceLabel ?? null],
          ["code", error.code],
          ["stage", diagnostic?.stage ?? null],
          ["message", error.message],
          ...(diagnostic?.modelIndex !== undefined
            ? [["modelIndex", diagnostic.modelIndex] as const]
            : []),
          ...((error.code === "discovery_failed" || diagnostic?.modelIndex !== undefined) &&
          diagnostic?.reason
            ? [["reason", diagnostic.reason] as const]
            : []),
          ["cliVersion", diagnostic?.cliVersion ?? null],
          ["durationMs", diagnostic?.durationMs ?? 0],
          ["retryInMs", diagnostic?.retryInMs ?? null],
        ]),
      ),
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
  resources.own(models.listen(() => services.providerStatuses?.publish()));
  // These CLIs own connect/disconnect outside ace. Metadata-only reconciliation is bounded.
  const connectionsTimer = setInterval(() => {
    models.revalidate();
    void models.reconcileConnections();
  }, 60_000);
  connectionsTimer.unref();
  resources.own(() => clearInterval(connectionsTimer));
  const account = services.accountRegistry?.selectedCursorSdk();
  const sdk =
    context.services.providerConfigurations?.for("cursor").enabled === false ||
    account ||
    options.modelInstances !== undefined
      ? undefined
      : await discoverCursorSdk(options.engine?.cursor?.discovery);
  const privateSdkConfigured =
    options.engine?.cursor?.instance !== undefined || config.cursorSdkHome !== undefined;
  const sdkInstance =
    (account && services.accountRegistry?.get(account)) ||
    (options.modelInstances === undefined && (sdk?.installed || privateSdkConfigured))
      ? await cursorSdkCatalogInstance(context)
      : undefined;
  if (sdkInstance) registerCursorSdkCatalog(context, sdkInstance);
  if (options.modelInstances === undefined) {
    registerConfiguredModelInstances(
      models,
      config.dataDir,
      services.providerConfigurations?.current() ?? [],
    );
    services.refreshModelInstances = (provider) =>
      models.hasInstance(`${provider}-cli-default`)
        ? Promise.resolve()
        : registerDefaultModelInstances(
            models,
            config.dataDir,
            process.env,
            context.signal,
            new Set(ProviderKind.options.filter((kind) => kind !== provider)),
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
      context.log.log("warn", "Default model admission failed", logError(error)),
    );
  }
}

import { handleModelRequest } from "../models.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function createModelsSession(context: SocketContext): SocketService {
  const { options, authorize, send, tasks } = context;
  let modelRequests = 0;
  let stopChanges: (() => void) | undefined;
  return {
    authenticated(channel) {
      if (channel !== undefined || stopChanges || !authorize("read")) return;
      stopChanges = options.models?.listen?.((filter) => {
        if (context.connected() && authorize("read")) send({ type: "models.changed", filter });
      });
    },
    close() {
      stopChanges?.();
    },
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
