import type { GitHubCopilotSettings, ServerProvider } from "@ace/contracts";
import { Cache, Duration, Effect, Equal, Layer, Result, Stream } from "effect";

import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { GitHubCopilotProvider } from "../Services/GitHubCopilotProvider";
import { isGitHubCopilotCliMissingError, probeGitHubCopilotSdk } from "../githubCopilotSdk";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@ace/contracts";

const PROVIDER = "githubCopilot" as const;

export const checkGitHubCopilotProviderStatus = Effect.fn("checkGitHubCopilotProviderStatus")(
  function* (): Effect.fn.Return<ServerProvider, ServerSettingsError, ServerSettingsService> {
    const settings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((value) => value.providers.githubCopilot),
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
          message: "GitHub Copilot is disabled in ace settings.",
        },
      });
    }

    const trimmedCliUrl = settings.cliUrl.trim();
    const probeResult = yield* Effect.tryPromise(() =>
      probeGitHubCopilotSdk(
        settings.binaryPath,
        trimmedCliUrl.length > 0 ? { cliUrl: trimmedCliUrl } : undefined,
      ),
    ).pipe(Effect.result);

    if (Result.isFailure(probeResult)) {
      const error = probeResult.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: settings.enabled,
        checkedAt,
        models: emptyModels,
        probe: {
          installed: !isGitHubCopilotCliMissingError(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isGitHubCopilotCliMissingError(error)
            ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
            : `Failed to start GitHub Copilot CLI via SDK: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    const probe = probeResult.success;
    const models = providerModelsFromSettings(probe.models, PROVIDER, settings.customModels);
    const auth =
      probe.auth === null
        ? { status: "unknown" as const }
        : {
            status: probe.auth.isAuthenticated
              ? ("authenticated" as const)
              : ("unauthenticated" as const),
            ...(probe.auth.authType ? { type: probe.auth.authType } : {}),
            ...(probe.auth.login
              ? { label: probe.auth.login }
              : probe.auth.statusMessage
                ? { label: probe.auth.statusMessage }
                : {}),
          };
    const issueMessage = probe.issues[0];

    if (probe.auth?.isAuthenticated === false) {
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
            probe.auth.statusMessage ??
            "GitHub Copilot CLI is not authenticated. Sign in with GitHub Copilot and try again.",
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
        ...(issueMessage
          ? {
              message: `GitHub Copilot is usable, but some metadata could not be refreshed. ${issueMessage}`,
            }
          : {}),
      },
    });
  },
);

export const GitHubCopilotProviderLive = Layer.effect(
  GitHubCopilotProvider,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const settingsCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        settingsService.getSettings.pipe(
          Effect.map((settings) => settings.providers.githubCopilot),
        ),
    });

    const checkProvider = checkGitHubCopilotProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, settingsService),
    );

    return yield* makeManagedServerProvider<GitHubCopilotSettings>({
      getSettings: Cache.get(settingsCache, "settings" as const).pipe(Effect.orDie),
      streamSettings: settingsService.streamChanges.pipe(
        Stream.map((settings) => settings.providers.githubCopilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      refreshInterval: "60 seconds",
    });
  }),
);
