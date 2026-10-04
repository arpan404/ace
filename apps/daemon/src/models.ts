import { join } from "node:path";
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
import {
  assertTestHomeIsolation,
  assertTestEnvironmentIsolation,
} from "@ace/provider-kit/test-isolation";
import type { ClientMessage, ServerMessage } from "@ace/protocol";

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
export function readModelInstances(env: NodeJS.ProcessEnv = process.env): InstanceInput[] {
  const instances = z
    .array(ModelInstance)
    .max(64)
    .parse(JSON.parse(env.ACE_MODEL_INSTANCES ?? "[]"));
  assertModelTestIsolation(instances);
  return instances;
}
export function openDaemonModels(
  dataDir: string,
  instances: readonly InstanceInput[],
  discoveryOptions: DiscoveryOptions = {},
): ModelCatalog {
  assertTestHomeIsolation(dataDir);
  assertModelTestIsolation(instances);
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
      await catalog.refresh(request.filter);
      return {
        type: "models.result",
        requestId: request.requestId,
        result: catalog.list(request.filter),
      };
  }
}
