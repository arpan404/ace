import type { GeminiSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Cache, Duration, Effect, Equal, Layer, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { GeminiProvider } from "../Services/GeminiProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@t3tools/contracts";

const PROVIDER = "gemini" as const;

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite Preview",
    isCustom: false,
    capabilities: null,
  },
] as const;

function parseGeminiVersion(result: {
  readonly stdout: string;
  readonly stderr: string;
}): string | null {
  return (
    parseGenericCliVersion(`${result.stdout}\n${result.stderr}`) ??
    nonEmptyTrimmed(result.stdout.split("\n").find((line) => line.trim().length > 0)) ??
    nonEmptyTrimmed(result.stderr.split("\n").find((line) => line.trim().length > 0)) ??
    null
  );
}

const runGeminiCommand = Effect.fn("runGeminiCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const geminiSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.gemini),
  );
  const command = ChildProcess.make(geminiSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
    env: {
      ...process.env,
    },
  });
  return yield* spawnAndCollect(geminiSettings.binaryPath, command);
});

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const settingsService = yield* ServerSettingsService;
    const geminiSettings = yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.gemini),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = providerModelsFromSettings(
      FALLBACK_MODELS,
      PROVIDER,
      geminiSettings.customModels,
    );

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Gemini CLI is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runGeminiCommand(["--version"]).pipe(Effect.result);
    if (Result.isFailure(versionResult)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(versionResult.failure),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(versionResult.failure)
            ? "Gemini CLI (`gemini`) is not installed or not on PATH."
            : `Failed to run Gemini CLI: ${versionResult.failure instanceof Error ? versionResult.failure.message : String(versionResult.failure)}.`,
        },
      });
    }

    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parseGeminiVersion(versionResult.success),
        status: "ready",
        auth: { status: "unknown" },
        message: "Gemini CLI detected. Authentication is verified when a session starts.",
      },
    });
  },
);

export const GeminiProviderLive = Layer.effect(
  GeminiProvider,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settingsCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        settingsService.getSettings.pipe(Effect.map((settings) => settings.providers.gemini)),
    });

    const checkProvider = checkGeminiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, settingsService),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );

    return yield* makeManagedServerProvider<GeminiSettings>({
      getSettings: Cache.get(settingsCache, "settings" as const).pipe(Effect.orDie),
      streamSettings: settingsService.streamChanges.pipe(
        Stream.map((settings) => settings.providers.gemini),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      refreshInterval: "60 seconds",
    });
  }),
);
