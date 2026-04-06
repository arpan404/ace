import type { OpenCodeSettings, ServerProvider } from "@ace/contracts";
import { Cache, Cause, Duration, Effect, Equal, Layer, Result, Stream } from "effect";

import {
  buildPendingServerProvider,
  buildServerProvider,
  providerModelsFromSettings,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { OpenCodeProvider } from "../Services/OpenCodeProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@ace/contracts";
import { startOpenCodeServer } from "../opencodeRuntime";
import { probeOpenCodeSdk } from "../opencodeSdk";

const PROVIDER = "opencode" as const;

function joinProviderMessages(parts: ReadonlyArray<string | undefined>): string | undefined {
  const messages = parts.filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return messages.length > 0 ? messages.join(" ") : undefined;
}

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(
  function* (): Effect.fn.Return<ServerProvider, ServerSettingsError, ServerSettingsService> {
    const settings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((value) => value.providers.opencode),
    );
    const checkedAt = new Date().toISOString();
    const emptyModels = providerModelsFromSettings([], PROVIDER, settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: emptyModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenCode is disabled in ace settings.",
        },
      });
    }

    const probeResult = yield* Effect.promise(async () => {
      const server = await startOpenCodeServer(settings.binaryPath);
      try {
        return await probeOpenCodeSdk(server.url);
      } finally {
        await server.close();
      }
    }).pipe(Effect.result);

    if (Result.isFailure(probeResult)) {
      const detail = Cause.pretty(probeResult.failure);
      const missing =
        detail.toLowerCase().includes("enoent") ||
        detail.toLowerCase().includes("notfound") ||
        detail.toLowerCase().includes("spawn");
      return buildServerProvider({
        provider: PROVIDER,
        enabled: settings.enabled,
        checkedAt,
        models: emptyModels,
        probe: {
          installed: !missing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: missing
            ? "OpenCode CLI (`opencode`) is not installed or not on PATH. Install OpenCode or set the binary path in settings."
            : detail,
        },
      });
    }

    const probe = probeResult.success;
    const models = providerModelsFromSettings(probe.models, PROVIDER, settings.customModels);

    const hasConnected = probe.connectedProviderIds.length > 0;
    const auth: ServerProvider["auth"] = hasConnected
      ? { status: "authenticated", label: probe.connectedProviderIds.join(", ") }
      : { status: "unknown" };
    const message = joinProviderMessages([
      !hasConnected
        ? "OpenCode is usable. Provider OAuth status is unknown — ensure API keys or auth are configured for your models."
        : undefined,
      probe.modelsTruncated
        ? `Showing featured OpenCode models, including the newest available release. Search the picker to browse the full catalog in 10-model pages.`
        : undefined,
    ]);

    if (models.length === 0) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: settings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: probe.version,
          status: "error",
          auth,
          message:
            "OpenCode is running, but no models were returned. Configure providers in OpenCode (`opencode` / opencode.json) and try again.",
        },
      });
    }

    return buildServerProvider({
      provider: PROVIDER,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: probe.version,
        status: "ready",
        auth,
        ...(message ? { message } : {}),
      },
    });
  },
);

export const OpenCodeProviderLive = Layer.effect(
  OpenCodeProvider,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const settingsCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        settingsService.getSettings.pipe(Effect.map((settings) => settings.providers.opencode)),
    });

    const checkProvider = checkOpenCodeProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, settingsService),
    );

    return yield* makeManagedServerProvider<OpenCodeSettings>({
      label: "OpenCode",
      cacheKey: PROVIDER,
      initialSnapshot: (settings) =>
        buildPendingServerProvider({
          provider: PROVIDER,
          enabled: settings.enabled,
          models: providerModelsFromSettings([], PROVIDER, settings.customModels),
          message: settings.enabled
            ? "Checking OpenCode availability..."
            : "OpenCode is disabled in ace settings.",
        }),
      getSettings: Cache.get(settingsCache, "settings" as const).pipe(Effect.orDie),
      streamSettings: settingsService.streamChanges.pipe(
        Stream.map((settings) => settings.providers.opencode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      refreshInterval: "60 seconds",
    });
  }),
);
