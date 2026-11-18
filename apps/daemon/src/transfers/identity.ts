import { ProjectIdentityId, type WorkspaceId } from "@ace/protocol";
import {
  identityOf,
  inGroup,
  keepAliases,
  registrationsOf,
  resolveIdentity,
  setIdentity,
  type CarriedIdentity,
} from "../project-identity.ts";
import type { ProjectStorage } from "../project-storage.ts";
import type { Store } from "../store.ts";

/*
 * Logical project identity across a transfer (ADR 0180). A transfer comes from one of the
 * person's own paired machines, so its identity is trusted the way a link is: a new landing,
 * and a reused registration with none, take it. A reused registration in another logical
 * project keeps its own; the result says so, and the person may link the two.
 */
export interface TransferIdentities {
  /** Sender: the source registration's identity, minting one (`created`) if it has none. */
  carried(workspaceId: WorkspaceId): CarriedIdentity | undefined;
  /** Target: registrations here in the sender's logical project, most recently used first. */
  holders(identity: CarriedIdentity): { workspaceId: WorkspaceId; path: string }[];
  /**
   * Target: the landed registration takes the sender's identity when it is new here (`fresh`)
   * or has none; otherwise the identity it keeps, when that is another logical project.
   */
  adopt(
    workspaceId: WorkspaceId,
    identity: CarriedIdentity,
    fresh: boolean,
  ): { identityId: ProjectIdentityId } | undefined;
}

export function transferIdentities(
  store: Store,
  catalog: () => ProjectStorage | undefined,
  newId: () => string,
  now: () => number,
): TransferIdentities {
  const announce = (workspaceId: WorkspaceId) => {
    try {
      catalog()?.announce(workspaceId);
    } catch {
      /* A registration gone meanwhile has nothing to announce. */
    }
  };
  return {
    carried(workspaceId) {
      const projects = catalog();
      if (!projects) return undefined;
      let minted = false;
      const carried = store.atomic((db) => {
        let kept;
        try {
          kept = projects.get(workspaceId).identity;
        } catch {
          // The source project is gone: the transfer goes on without an identity.
          return undefined;
        }
        if (kept) return { id: kept.id, aliases: kept.aliases };
        const id = ProjectIdentityId.parse(newId());
        setIdentity(db, workspaceId, id, "created", now());
        minted = true;
        return { id, aliases: [] };
      });
      if (minted) announce(workspaceId);
      return carried;
    },
    holders: (identity) => store.atomic((db) => registrationsOf(db, identity)),
    adopt(workspaceId, identity, fresh) {
      const outcome = store.atomic((db) => {
        const kept = identityOf(db, workspaceId);
        if (!fresh && kept !== undefined && kept !== identity.id) {
          return inGroup(db, kept, identity)
            ? { changed: false }
            : { changed: false, conflict: ProjectIdentityId.parse(kept) };
        }
        keepAliases(db, identity, now());
        // An id merged here into another is that other one here.
        const id = resolveIdentity(db, identity.id);
        if (kept === id) return { changed: false };
        setIdentity(db, workspaceId, id, "transfer", now());
        return { changed: true };
      });
      if (outcome.changed) announce(workspaceId);
      return outcome.conflict ? { identityId: outcome.conflict } : undefined;
    },
  };
}
