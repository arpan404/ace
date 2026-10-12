import type { GitOptions } from "@ace/git";
import type { ServiceContext } from "./types.ts";

/** All daemon-owned push/fetch clients share the engine's existing reservation owner. */
export function repositoryTransferGuard(
  context: Pick<ServiceContext, "services">,
): NonNullable<GitOptions["withRepositoryTransfer"]> {
  return (repository, operation) => {
    const engine = context.services.engine;
    if (!engine) return Promise.reject(new Error("engine_unavailable"));
    return engine.withRepositoryTransfer(repository, operation);
  };
}
