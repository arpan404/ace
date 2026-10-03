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
import type { ClientMessage, ServerMessage } from "@ace/protocol";

/** Local launch configuration only. Never accepted from remote socket clients. */
export function readModelInstances(env: NodeJS.ProcessEnv = process.env): InstanceInput[] {
  return z
    .array(ModelInstance)
    .max(64)
    .parse(JSON.parse(env.ACE_MODEL_INSTANCES ?? "[]"));
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
      await catalog.refresh(request.filter);
      return {
        type: "models.result",
        requestId: request.requestId,
        result: catalog.list(request.filter),
      };
  }
}
