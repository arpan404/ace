import * as OS from "node:os";
import type {
  ModelCapabilities,
  CodexSettings,
  ServerProvider,
  ServerProviderModel,
  ServerProviderAuth,
  ServerProviderState,
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
  MINIMUM_CODEX_CLI_VERSION,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { getFallbackCodexModelCapabilities, parseCodexDebugModelsOutput } from "../codexCatalog";
import { CodexProvider } from "../Services/CodexProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@ace/contracts";

const PROVIDER = "codex" as const;
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);
type CodexCatalogParseError = {
  readonly _tag: "CodexCatalogParseError";
  readonly message: string;
};

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeCodexAuthLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase().replace(/[\s_-]+/g, "");
  switch (normalized) {
    case "chatgpt":
      return "ChatGPT";
    case "apikey":
      return "API Key";
    default:
      return toTitleCaseWords(trimmed);
  }
}

export function parseCodexAuthStatusFromOutput(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status" | "label">;
  readonly message?: string;
} {
  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
  const lowerOutput = combinedOutput.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message: "Codex login status command is unavailable in this version of Codex.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex is not authenticated. Run `codex login` and try again.",
    };
  }

  const usingMatch = combinedOutput.match(/logged in using\s+(.+)$/im);
  if (result.code === 0 && usingMatch) {
    return {
      status: "ready",
      auth: {
        status: "authenticated",
        ...(normalizeCodexAuthLabel(usingMatch[1])
          ? { label: normalizeCodexAuthLabel(usingMatch[1]) }
          : {}),
      },
    };
  }

  if (result.code === 0) {
    return { status: "ready", auth: { status: "authenticated" } };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

export function getCodexModelCapabilities(model: string | null | undefined): ModelCapabilities {
  return getFallbackCodexModelCapabilities(model);
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
    const emptyModels = providerModelsFromSettings([], PROVIDER, codexSettings.customModels);

    if (!codexSettings.enabled) {
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
        models: emptyModels,
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
        models: emptyModels,
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
        models: emptyModels,
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
        models: emptyModels,
        probe: {
          installed: true,
          version: parsedVersion,
          minimumVersion: MINIMUM_CODEX_CLI_VERSION,
          versionStatus: "upgrade-required",
          status: "warning",
          auth: { status: "unknown" },
          message: formatCodexCliUpgradeMessage(parsedVersion),
        },
      });
    }

    const usesCustomModelProvider = yield* hasCustomModelProvider;

    let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
    let modelsIssueMessage: string | undefined;
    const modelsProbe = yield* runCodexCommand(["debug", "models"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(modelsProbe)) {
      const error = modelsProbe.failure;
      modelsIssueMessage =
        error instanceof Error
          ? `Failed to refresh available models: ${error.message}.`
          : `Failed to refresh available models: ${String(error)}.`;
    } else if (Option.isNone(modelsProbe.success)) {
      modelsIssueMessage = "Timed out while refreshing available models.";
    } else {
      const modelsResult = modelsProbe.success.value;
      if (modelsResult.code !== 0) {
        const detail = detailFromResult(modelsResult);
        modelsIssueMessage = detail
          ? `Failed to refresh available models. ${detail}`
          : "Failed to refresh available models.";
      } else {
        const catalogOutput = modelsResult.stdout.trim();
        const parsedModels = yield* Effect.try({
          try: () => parseCodexDebugModelsOutput(catalogOutput),
          catch: (error): CodexCatalogParseError => ({
            _tag: "CodexCatalogParseError",
            message: error instanceof Error ? error.message : String(error),
          }),
        }).pipe(Effect.result);
        if (Result.isFailure(parsedModels)) {
          modelsIssueMessage = `Failed to parse available models: ${parsedModels.failure.message}.`;
        } else {
          discoveredModels = parsedModels.success;
          if (discoveredModels.length === 0) {
            modelsIssueMessage = "No selectable models were returned by Codex.";
          }
        }
      }
    }

    const models = providerModelsFromSettings(
      discoveredModels,
      PROVIDER,
      codexSettings.customModels,
    );

    if (usesCustomModelProvider) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: codexSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          minimumVersion: MINIMUM_CODEX_CLI_VERSION,
          versionStatus: parsedVersion ? "ok" : "unknown",
          status: modelsIssueMessage ? "warning" : "ready",
          auth: { status: "unknown" },
          message: modelsIssueMessage
            ? `Using a custom Codex model provider. ${modelsIssueMessage}`
            : "Using a custom Codex model provider.",
        },
      });
    }

    const authProbe = yield* runCodexCommand(["login", "status"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: codexSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          minimumVersion: MINIMUM_CODEX_CLI_VERSION,
          versionStatus: parsedVersion ? "ok" : "unknown",
          status: "warning",
          auth: { status: "unknown" },
          message: modelsIssueMessage
            ? `Could not verify Codex authentication status: ${error instanceof Error ? error.message : String(error)}. ${modelsIssueMessage}`
            : error instanceof Error
              ? `Could not verify Codex authentication status: ${error.message}.`
              : "Could not verify Codex authentication status.",
        },
      });
    }

    if (Option.isNone(authProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: codexSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          minimumVersion: MINIMUM_CODEX_CLI_VERSION,
          versionStatus: parsedVersion ? "ok" : "unknown",
          status: "warning",
          auth: { status: "unknown" },
          message: modelsIssueMessage
            ? `Could not verify Codex authentication status. Timed out while running command. ${modelsIssueMessage}`
            : "Could not verify Codex authentication status. Timed out while running command.",
        },
      });
    }

    const parsedAuth = parseCodexAuthStatusFromOutput(authProbe.success.value);
    const resolvedStatus =
      parsedAuth.status === "error" ? "error" : modelsIssueMessage ? "warning" : parsedAuth.status;
    const resolvedMessage =
      parsedAuth.message && modelsIssueMessage
        ? `${parsedAuth.message} ${modelsIssueMessage}`
        : parsedAuth.message
          ? parsedAuth.message
          : modelsIssueMessage
            ? `Codex is usable, but ${modelsIssueMessage}`
            : undefined;

    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        minimumVersion: MINIMUM_CODEX_CLI_VERSION,
        versionStatus: parsedVersion ? "ok" : "unknown",
        status: resolvedStatus,
        auth: parsedAuth.auth,
        ...(resolvedMessage ? { message: resolvedMessage } : {}),
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
          models: providerModelsFromSettings([], PROVIDER, settings.customModels),
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
