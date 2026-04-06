import * as OS from "node:os";
import type {
  ModelCapabilities,
  CodexSettings,
  ServerProvider,
  ServerProviderModel,
} from "@ace/contracts";
import { Effect, Equal, FileSystem, Layer, Option, Path, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildPendingServerProvider,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { CodexProvider } from "../Services/CodexProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@ace/contracts";

const PROVIDER = "codex" as const;
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.2",
    name: "GPT-5.2",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

export function getCodexModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ?? {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    }
  );
}

export const readCodexConfigModelProvider = Effect.fn("readCodexConfigModelProvider")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService;
  const codexHome = yield* settingsService.getSettings.pipe(
    Effect.map(
      (settings) =>
        settings.providers.codex.homePath ||
        process.env.CODEX_HOME ||
        path.join(OS.homedir(), ".codex"),
    ),
  );
  const configPath = path.join(codexHome, "config.toml");

  const content = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (content === undefined) {
    return undefined;
  }

  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;

    const match = trimmed.match(/^model_provider\s*=\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  return undefined;
});

export const hasCustomModelProvider = readCodexConfigModelProvider().pipe(
  Effect.map((provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider)),
  Effect.orElseSucceed(() => false),
);

const runCodexCommand = Effect.fn("runCodexCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const codexSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.codex),
  );
  const command = ChildProcess.make(codexSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...(codexSettings.homePath ? { CODEX_HOME: codexSettings.homePath } : {}),
    },
  });
  return yield* spawnAndCollect(codexSettings.binaryPath, command);
});

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
    | ServerSettingsService
  > {
    const codexSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.codex),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      codexSettings.customModels,
    );

    if (!codexSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Codex is disabled in ace settings.",
        },
      });
    }

    const versionProbe = yield* runCodexCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: codexSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Codex CLI (`codex`) is not installed or not on PATH."
            : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: codexSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Codex CLI is installed but failed to run. Timed out while running command.",
        },
      });
    }

    const version = versionProbe.success.value;
    const parsedVersion =
      parseCodexCliVersion(`${version.stdout}\n${version.stderr}`) ??
      parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: codexSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message: detail
            ? `Codex CLI is installed but failed to run. ${detail}`
            : "Codex CLI is installed but failed to run.",
        },
      });
    }

    if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: codexSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message: formatCodexCliUpgradeMessage(parsedVersion),
        },
      });
    }

    if (yield* hasCustomModelProvider) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: codexSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "ready",
          auth: { status: "unknown" },
          message: "Using a custom Codex model provider.",
        },
      });
    }

    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth: { status: "unknown" },
      },
    });
  },
);

export const CodexProviderLive = Layer.effect(
  CodexProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkCodexProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CodexSettings>({
      label: "Codex",
      cacheKey: PROVIDER,
      initialSnapshot: (settings) =>
        buildPendingServerProvider({
          provider: PROVIDER,
          enabled: settings.enabled,
          models: providerModelsFromSettings(BUILT_IN_MODELS, PROVIDER, settings.customModels),
          message: settings.enabled
            ? "Checking Codex availability..."
            : "Codex is disabled in ace settings.",
        }),
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.codex),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.codex),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
