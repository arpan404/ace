import type { ClientApi } from "@ace/client";
import { remoteKeyVersionPrefix } from "@ace/protocol";
import { unambiguousRemoteKey } from "@ace/ui-core/project-groups";

/*
 * The same repository on two machines (ADR 0102): project ids belong to one daemon, so a
 * checkout is matched across machines by its `origin`, the way a transfer reuses one. A daemon
 * that can't answer (an older one, or one that went away) has no copy to offer.
 */

/**
 * The project's `origin` on the machine `client` reaches: its fetch URL and, from a daemon that
 * versions them, its remote key; undefined without one.
 */
export async function projectOrigin(
  client: ClientApi,
  project: string,
): Promise<{ url: string; key?: string | undefined } | undefined> {
  try {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op: "workspace.origin", workspaceId: project },
    });
    if (reply.result.kind !== "origin" || !reply.result.url) return undefined;
    return { url: reply.result.url, key: reply.result.key };
  } catch {
    return undefined;
  }
}

/**
 * The project whose `origin` is the same repository as `url`, on the machine `client` reaches:
 * the one at `subpath` inside it when there is one, else its most recently used (a daemon older
 * than subpaths ignores it and answers as before).
 */
export async function projectWithOrigin(
  client: ClientApi,
  origin: { url: string; key?: string | undefined },
  subpath = "",
): Promise<string | undefined> {
  try {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op: "workspaces.match", url: origin.url, ...(subpath ? { subpath } : {}) },
    });
    if (reply.result.kind !== "match" || !reply.result.workspaceId) return undefined;
    return trustedMatch(reply.result.keyVersion, origin.key) ? reply.result.workspaceId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a match is the same repository: one by versioned keys, or, from a daemon before them,
 * one of a public forge's repository (its origin's key unversioned and unambiguous), whose keys
 * never changed meaning. An older daemon's match elsewhere may be an SSH path from a home taken
 * for one from the root, so New thread copies the project instead.
 */
function trustedMatch(keyVersion: 2 | undefined, originKey: string | undefined): boolean {
  if (keyVersion === 2) return true;
  return (
    originKey !== undefined &&
    !originKey.startsWith(remoteKeyVersionPrefix) &&
    unambiguousRemoteKey(originKey)
  );
}
