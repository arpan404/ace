import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ModelCatalog,
  ModelInstance,
  createModelDiscovery,
  openModelStorage,
  type InstanceInput,
  type ModelCatalogApi,
  type DiscoveryOptions,
} from "@ace/models";
import { z } from "zod";
import type { ClientMessage, ServerMessage, ProviderKind } from "@ace/protocol";
import { findExecutable } from "@ace/provider-kit/discovery";

/** Local launch configuration only. Never accepted from remote socket clients. */
export function readModelInstances(
  env: NodeJS.ProcessEnv = process.env,
): InstanceInput[] | undefined {
  if (env.ACE_MODEL_INSTANCES === undefined) return undefined;
  return z
    .array(ModelInstance)
    .max(64)
    .parse(JSON.parse(env.ACE_MODEL_INSTANCES ?? "[]"));
}
/** Filesystem-only admission. Actual metadata probes remain lazy, cached catalog work. */
export async function registerDefaultModelInstances(
  catalog: ModelCatalog,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  registeredProviders: ReadonlySet<ProviderKind>,
): Promise<void> {
  const candidates = [
    { provider: "codex", executable: "codex" },
    { provider: "claude", executable: "claude" },
    { provider: "opencode", executable: "opencode" },
    { provider: "pi", executable: "pi" },
    { provider: "cursor", executable: "agent" },
  ] as const;
  const installed = await Promise.all(
    candidates
      .filter((candidate) => !registeredProviders.has(candidate.provider))
      .map(async (candidate) => ({
        provider: candidate.provider,
        path: await findExecutable(candidate.executable, env),
      })),
  );
  if (signal.aborted) return;
  for (const candidate of installed) {
    if (!candidate.path) continue;
    catalog.registerInstance({
      id: `${candidate.provider}-cli-default`,
      provider: candidate.provider,
      executable: candidate.path,
      cwd,
      // Installation identity is stable; explicit models.refresh revokes account-bound cache.
      loginRevision: createHash("sha256").update(candidate.path).digest("hex"),
    });
  }
}
export function openDaemonModels(
  dataDir: string,
  instances: readonly InstanceInput[],
  discoveryOptions: DiscoveryOptions = {},
): ModelCatalog {
  const storage = openModelStorage(join(dataDir, "models.sqlite"));
  try {
    return new ModelCatalog({
      storage,
      instances,
      discover: createModelDiscovery(discoveryOptions),
      now: Date.now,
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
        result: catalog.list(request.options),
      };
    case "models.resolve":
      return {
        type: "models.result",
        requestId: request.requestId,
        result: catalog.resolve(request.roleSpec),
      };
    case "models.refresh":
      await catalog.invalidate(request.filter);
      await catalog.refresh(request.filter);
      return {
        type: "models.result",
        requestId: request.requestId,
        result: catalog.list(request.filter),
      };
  }
}
