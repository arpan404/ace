import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  PiSettings,
  ServerProvider,
  ServerProviderModel,
  ServerProviderRuntime,
} from "@ace/contracts";
import { ServerSettingsError } from "@ace/contracts";
import { Cache, Duration, Effect, Equal, Layer, Option, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { PiProvider } from "../Services/PiProvider.ts";
import {
  buildPendingServerProvider,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";

const PROVIDER = "pi" as const;
const PI_RUNTIME_ID = "pi" as const;
const PI_RPC_TIMEOUT_MS = 5_000;

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
};

type PiRpcModel = {
  readonly id: string;
  readonly name: string;
  readonly provider?: string;
};

class PiRpcDiscoveryError extends Schema.TaggedErrorClass<PiRpcDiscoveryError>()(
  "PiRpcDiscoveryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

function resolvePiAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(homedir(), ".pi", "agent");
}

function parsePiVersion(result: CommandResult): string | null {
  return (
    parseGenericCliVersion(`${result.stdout}\n${result.stderr}`) ??
    nonEmptyTrimmed(result.stdout.split("\n").find((line) => line.trim().length > 0)) ??
    nonEmptyTrimmed(result.stderr.split("\n").find((line) => line.trim().length > 0)) ??
    null
  );
}

function buildPiRuntime(
  input: Omit<ServerProviderRuntime, "upgradeable"> & { readonly upgradeable?: boolean },
): ServerProviderRuntime {
  return {
    ...input,
    upgradeable: input.upgradeable ?? true,
  };
}

function readConfiguredPiDefaultModel(): string | null {
  try {
    const settingsPath = path.join(resolvePiAgentDir(), "settings.json");
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      readonly defaultProvider?: unknown;
      readonly defaultModel?: unknown;
    };
    const defaultProvider =
      typeof parsed.defaultProvider === "string" ? parsed.defaultProvider.trim() : "";
    const defaultModel = typeof parsed.defaultModel === "string" ? parsed.defaultModel.trim() : "";
    if (!defaultModel) {
      return null;
    }
    if (defaultProvider && !defaultModel.includes("/")) {
      return `${defaultProvider}/${defaultModel}`;
    }
    return defaultModel;
  } catch {
    return null;
  }
}

async function runPiRpcGetModels(binaryPath: string): Promise<ReadonlyArray<PiRpcModel>> {
  const child = spawn(binaryPath, ["--mode", "rpc", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  return await new Promise<ReadonlyArray<PiRpcModel>>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error("Timed out while querying Pi RPC models."));
      }
    }, PI_RPC_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type !== "response" || parsed.command !== "get_available_models") {
            continue;
          }
          if (parsed.success !== true) {
            finish(() =>
              reject(
                new Error(
                  typeof parsed.error === "string" ? parsed.error : "Pi RPC model lookup failed.",
                ),
              ),
            );
            child.kill("SIGTERM");
            return;
          }
          const data =
            parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
              ? (parsed.data as Record<string, unknown>)
              : undefined;
          const models = Array.isArray(data?.models) ? data.models : [];
          finish(() =>
            resolve(
              models.flatMap((entry) => {
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                  return [];
                }
                const record = entry as Record<string, unknown>;
                const id = nonEmptyTrimmed(typeof record.id === "string" ? record.id : undefined);
                const name =
                  nonEmptyTrimmed(typeof record.name === "string" ? record.name : undefined) ?? id;
                const provider = nonEmptyTrimmed(
                  typeof record.provider === "string" ? record.provider : undefined,
                );
                return id && name ? [{ id, name, ...(provider ? { provider } : {}) }] : [];
              }),
            ),
          );
          child.kill("SIGTERM");
          return;
        } catch {
          continue;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      finish(() =>
        reject(
          new Error(
            nonEmptyTrimmed(stderr) ??
              (code === 0
                ? "Pi RPC exited before returning models."
                : `Pi RPC exited with code ${String(code)}.`),
          ),
        ),
      );
    });

    child.stdin.write(
      `${JSON.stringify({ id: "ace:get-models", type: "get_available_models" })}\n`,
    );
    child.stdin.end();
  });
}

function normalizePiRpcModels(
  models: ReadonlyArray<PiRpcModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const builtInModels: ServerProviderModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const slug =
      model.provider && !model.id.startsWith(`${model.provider}/`)
        ? `${model.provider}/${model.id}`
        : model.id;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    builtInModels.push({
      slug,
      name: model.name,
      isCustom: false,
      capabilities: null,
    });
  }
  return providerModelsFromSettings(builtInModels, PROVIDER, customModels);
}

const runProviderCommand = Effect.fn("runProviderCommand")(function* (
  binaryPath: string,
  args: ReadonlyArray<string>,
) {
  const command = ChildProcess.make(binaryPath, [...args], {
    shell: process.platform === "win32",
    env: process.env,
  });
  return yield* spawnAndCollect(binaryPath, command);
});

function fallbackPiModels(settings: PiSettings): ReadonlyArray<ServerProviderModel> {
  const builtInModels: ServerProviderModel[] = [];
  const configuredDefaultModel = readConfiguredPiDefaultModel();
  if (configuredDefaultModel) {
    builtInModels.push({
      slug: configuredDefaultModel,
      name: configuredDefaultModel,
      isCustom: false,
      capabilities: null,
    });
  }
  return providerModelsFromSettings(builtInModels, PROVIDER, settings.customModels);
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService.getSettings.pipe(Effect.map((all) => all.providers.pi));
    const checkedAt = new Date().toISOString();
    const fallbackModels = fallbackPiModels(settings);
    const baseRuntimes = {
      pi: buildPiRuntime({
        id: PI_RUNTIME_ID,
        label: "Pi",
        binaryPath: settings.binaryPath,
        installed: false,
        version: null,
        packageName: "@mariozechner/pi-coding-agent",
      }),
    };

    if (!settings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        runtimes: [baseRuntimes.pi],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in ace settings.",
        },
      });
    }

    const piVersionResult = yield* runProviderCommand(settings.binaryPath, ["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    const piInstalled = Result.isSuccess(piVersionResult) && Option.isSome(piVersionResult.success);
    const piVersion =
      piInstalled && Option.isSome(piVersionResult.success)
        ? parsePiVersion(piVersionResult.success.value)
        : null;
    const runtimes: ReadonlyArray<ServerProviderRuntime> = [
      {
        ...baseRuntimes.pi,
        installed: piInstalled && !Result.isFailure(piVersionResult),
        version: piVersion,
      },
    ];

    if (!piInstalled) {
      const detail =
        Result.isFailure(piVersionResult) && !piInstalled
          ? isCommandMissingCause(piVersionResult.failure)
            ? null
            : String(piVersionResult.failure)
          : null;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        runtimes,
        probe: {
          installed: false,
          version: piVersion,
          status: "error",
          auth: { status: "unknown" },
          message: detail
            ? `Missing required Pi runtime: Pi CLI (\`pi\`). ${detail}`
            : "Missing required Pi runtime: Pi CLI (`pi`).",
        },
      });
    }

    const discoveredModelsResult = yield* Effect.tryPromise({
      try: () => runPiRpcGetModels(settings.binaryPath),
      catch: (cause) =>
        new PiRpcDiscoveryError({
          message: cause instanceof Error ? cause.message : "Pi RPC model discovery failed.",
          cause,
        }),
    }).pipe(Effect.result);

    const models = Result.isSuccess(discoveredModelsResult)
      ? normalizePiRpcModels(discoveredModelsResult.success, settings.customModels)
      : fallbackModels;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      runtimes,
      probe: {
        installed: true,
        version: piVersion,
        status: "ready",
        auth: { status: "unknown" },
        message: Result.isFailure(discoveredModelsResult)
          ? "Pi detected. Falling back to local model settings because RPC discovery failed."
          : "Pi detected. Authentication is verified when a session starts.",
      },
    });
  },
);

export const PiProviderLive = Layer.effect(
  PiProvider,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settingsCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        settingsService.getSettings.pipe(Effect.map((settings) => settings.providers.pi)),
    });

    const checkProvider = checkPiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, settingsService),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );

    return yield* makeManagedServerProvider<PiSettings>({
      label: "Pi",
      cacheKey: PROVIDER,
      initialSnapshot: (settings) =>
        buildPendingServerProvider({
          provider: PROVIDER,
          enabled: settings.enabled,
          models: fallbackPiModels(settings),
          runtimes: [
            buildPiRuntime({
              id: PI_RUNTIME_ID,
              label: "Pi",
              binaryPath: settings.binaryPath,
              installed: false,
              version: null,
              packageName: "@mariozechner/pi-coding-agent",
            }),
          ],
          message: settings.enabled
            ? "Checking Pi availability..."
            : "Pi is disabled in ace settings.",
        }),
      getSettings: Cache.get(settingsCache, "settings" as const).pipe(Effect.orDie),
      streamSettings: settingsService.streamChanges.pipe(
        Stream.map((settings) => settings.providers.pi),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
