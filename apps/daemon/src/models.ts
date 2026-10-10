import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ModelCatalog,
  ModelInstance,
  createModelDiscovery,
  createModelRevisionProbe,
  openModelStorage,
  type InstanceInput,
  type ModelCatalogApi,
  type DiscoveryOptions,
  type CatalogOptions,
} from "@ace/models";
import { providerConfiguration } from "@ace/models/preferences";
import { z } from "zod";
import type { ClientMessage, ServerMessage, ProviderKind } from "@ace/protocol";
import {
  findExecutable,
  findOpenCodeExecutable,
  defaultProviderExecutable,
} from "@ace/provider-kit/discovery";
import {
  assertTestHomeIsolation,
  assertTestEnvironmentIsolation,
} from "@ace/provider-kit/test-isolation";

/** Shared test-only preflight for CLI, daemon startup and direct model-service callers. */
export function assertModelTestIsolation(instances: readonly InstanceInput[]): void {
  if (!process.env.ACE_TEST_REAL_HOME) return;
  for (const instance of instances) {
    assertTestHomeIsolation(instance.cwd);
    if (instance.homeDir) assertTestHomeIsolation(instance.homeDir);
    if (instance.env) assertTestEnvironmentIsolation(instance.env);
  }
}

/** Local launch configuration only. Never accepted from remote socket clients. */
export function readModelInstances(
  env: NodeJS.ProcessEnv = process.env,
): InstanceInput[] | undefined {
  if (env.ACE_MODEL_INSTANCES === undefined) return undefined;
  const instances = z
    .array(ModelInstance)
    .max(64)
    .parse(JSON.parse(env.ACE_MODEL_INSTANCES ?? "[]"));
  assertModelTestIsolation(instances);
  return instances;
}
/** Admit installed CLIs; OpenCode also needs a v2 version before registering its binding. */
export async function registerDefaultModelInstances(
  catalog: ModelCatalog,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  registeredProviders: ReadonlySet<ProviderKind>,
  preferences: import("@ace/protocol").ProviderConfigurations = [],
): Promise<void> {
  if (process.env.ACE_TEST_REAL_HOME) assertTestHomeIsolation(cwd);
  const candidates = [
    { provider: "codex", executable: "codex" },
    { provider: "claude", executable: "claude" },
    { provider: "opencode", executable: "opencode" },
    { provider: "pi", executable: "pi" },
  ] as const;
  const installed = await Promise.all(
    candidates
      .filter((candidate) => !registeredProviders.has(candidate.provider))
      .map(async (candidate) => {
        const override = providerConfiguration(preferences, candidate.provider).binaryPath;
        const path =
          candidate.provider === "opencode"
            ? (await findOpenCodeExecutable(override ?? candidate.executable, { env, signal }))
                ?.path
            : await findExecutable(override ?? candidate.executable, env);
        const executable = override
          ? ((candidate.provider === "opencode"
              ? (await findOpenCodeExecutable(candidate.executable, { env, signal }))?.path
              : await findExecutable(candidate.executable, env)) ?? candidate.executable)
          : (path ?? candidate.executable);
        return { provider: candidate.provider, path, executable };
      }),
  );
  if (signal.aborted) return;
  for (const candidate of installed) {
    if (!candidate.path) continue;
    catalog.registerInstance({
      id: `${candidate.provider}-cli-default`,
      label: "Default",
      provider: candidate.provider,
      executable: candidate.executable,
      cwd,
      // Installation identity is stable; account owners invalidate when login identity changes.
      loginRevision: createHash("sha256").update(candidate.path).digest("hex"),
    });
  }
}
/** Explicit paths can admit a previously missing CLI without a restart or a probe. */
export function registerConfiguredModelInstances(
  catalog: ModelCatalog,
  cwd: string,
  preferences: import("@ace/protocol").ProviderConfigurations,
): void {
  for (const config of preferences) {
    if (config.instance || !config.binaryPath || catalog.hasProvider(config.provider)) continue;
    if (
      config.provider === "acp" ||
      config.provider === "antigravity" ||
      config.provider === "cursor"
    )
      continue;
    catalog.registerInstance({
      id: `${config.provider}-cli-default`,
      label: "Default",
      provider: config.provider,
      executable: defaultProviderExecutable(config.provider),
      cwd,
      loginRevision: createHash("sha256").update(config.binaryPath).digest("hex"),
    });
  }
}
export function openDaemonModels(
  dataDir: string,
  instances: readonly InstanceInput[],
  discoveryOptions: DiscoveryOptions = {},
  preferences?: CatalogOptions["preferences"],
  onError?: CatalogOptions["onError"],
): ModelCatalog {
  assertTestHomeIsolation(dataDir);
  assertModelTestIsolation(instances);
  const storage = openModelStorage(join(dataDir, "models.sqlite"));
  try {
    return new ModelCatalog({
      storage,
      ...(preferences ? { preferences } : {}),
      ...(onError ? { onError } : {}),
      instances,
      discover: createModelDiscovery(discoveryOptions),
      revisionProbe: createModelRevisionProbe(discoveryOptions.spawn),
      now: Date.now,
      random: Math.random,
      deadline(expire, ms) {
        const timer = setTimeout(expire, ms);
        return () => clearTimeout(timer);
      },
    });
  } catch (error) {
    void Promise.resolve(storage.close()).catch(() => {});
    throw error;
  }
}
export type ModelRequest = Extract<
  ClientMessage,
  { type: "models.list" | "models.refresh" | "models.resolve" }
>;
export async function handleModelRequest(
  catalog: ModelCatalogApi,
  request: ModelRequest,
): Promise<ServerMessage> {
  switch (request.type) {
    case "models.list":
      return {
        type: "models.result",
        requestId: request.requestId,
        result: catalog.list({
          ...request.options,
          instance: cursorInstanceId(request.options.instance),
        }),
      };
    case "models.resolve":
      return {
        type: "models.result",
        requestId: request.requestId,
        result: catalog.resolve({
          ...request.roleSpec,
          instance: cursorInstanceId(request.roleSpec.instance),
        }),
      };
    case "models.refresh":
      const filter = { ...request.filter, instance: cursorInstanceId(request.filter.instance) };
      await catalog.refresh(filter);
      return {
        type: "models.result",
        requestId: request.requestId,
        result: catalog.list(filter),
      };
  }
}
