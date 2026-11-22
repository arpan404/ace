import type { Store } from "../store.ts";
import { loadDelegationTrees } from "../storage/ownership.ts";
import { structuralTrees, type TreeResolver } from "./trees.ts";

/**
 * The daemon's tree resolver for the access policy: the one injected (the access table's, ADR
 * 0209 §5.3), else part A's, which places threads by their delegation tree and grants no access.
 */
export function serverTrees(options: {
  store: Store;
  orgTrees?: TreeResolver | undefined;
}): TreeResolver {
  if (options.orgTrees) return options.orgTrees;
  return structuralTrees((thread) => loadDelegationTrees(options.store, [thread]).rootOf(thread));
}
