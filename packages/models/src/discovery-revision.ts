import type { CatalogModel, ModelSource } from "@ace/protocol";
import { createHash } from "node:crypto";
import { connectedOpenCodeProviders } from "./opencode-connections.ts";
import { discoverListedModels } from "./list-discovery.ts";
import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import type { ModelInstance } from "./types.ts";

/** Hash only allowlisted non-secret provider identities and model availability. */
export function connectionRevision(
  provider: ModelInstance["provider"],
  models: readonly CatalogModel[],
  sources: readonly ModelSource[],
): string {
  const values =
    provider === "opencode"
      ? sources
          .map((source) => JSON.stringify([source.kind, source.id, source.label, source.service]))
          .toSorted()
      : models.map((model) => `${model.nativeProviderId ?? ""}/${model.id}`).toSorted();
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
export function createModelRevisionProbe(
  spawn: (options: SpawnOptions) => SupervisedProcess = spawnSupervised,
) {
  return async (instance: ModelInstance, signal: AbortSignal): Promise<string> => {
    if (instance.provider === "opencode") {
      const connections = await connectedOpenCodeProviders(instance, signal, spawn);
      return connectionRevision(instance.provider, [], [...connections.values()]);
    }
    if (instance.provider === "pi") {
      const models = await discoverListedModels(instance, signal, spawn);
      return connectionRevision(instance.provider, models, []);
    }
    throw new Error("Connection metadata is not available for this provider");
  };
}
