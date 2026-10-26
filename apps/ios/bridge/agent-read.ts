import type { ClientCore } from "@ace/client";
import { catalogModelIds, readModelCatalog, type ModelCatalog } from "@ace/ui-core";
import { newThreadAgents, type NewThreadAgents } from "@ace/ui-core/mobile";
import type { ModelFavorites } from "./model-favorites.ts";

/*
 * Every coding agent on the machine with its accounts and models, and the starred models: what
 * New thread's picker and an open thread's model sheet both list (`newThreadAgents`). One read
 * of readiness, accounts, the model catalog and the stars, in parallel.
 */

export interface AgentRead {
  agents: NewThreadAgents;
  catalog: ModelCatalog;
  /** Starred models as picker keys; none when the setting can't be read. */
  stars: string[];
}

const quiet = { timeoutMs: 15_000 };

/** Rejects when the machine can't say which coding agents are ready. */
export async function readAgents(
  owner: Pick<ClientCore, "request">,
  favorites: ModelFavorites,
  now: number,
): Promise<AgentRead> {
  const catalogRead = readModelCatalog(owner, {}).catch((): ModelCatalog => ({
    models: [],
    instances: [],
  }));
  const [readiness, accounts, catalog, stars] = await Promise.all([
    owner.request({ type: "providers.request", operation: "readiness" }, quiet),
    owner
      .request({ type: "accounts.list" }, quiet)
      .then((reply) => reply.accounts)
      .catch(() => []),
    catalogRead,
    catalogRead.then((read) => favorites.read(catalogModelIds(read.models))),
  ]);
  if (!readiness.result.ok) throw new Error(readiness.result.error);
  const agents = newThreadAgents({
    statuses: readiness.result.providers,
    accounts,
    catalog,
    now,
  });
  return { agents, catalog, stars };
}
