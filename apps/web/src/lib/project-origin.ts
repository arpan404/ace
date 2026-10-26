import type { ClientApi } from "@ace/client";

/*
 * The same repository on two machines (ADR 0102): project ids belong to one daemon, so a
 * checkout is matched across machines by its `origin`, the way a transfer reuses one. A daemon
 * that can't answer (an older one, or one that went away) has no copy to offer.
 */

/** The project's `origin` fetch URL on the machine `client` reaches; undefined without one. */
export async function projectOrigin(
  client: ClientApi,
  project: string,
): Promise<string | undefined> {
  try {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op: "workspace.origin", workspaceId: project },
    });
    return reply.result.kind === "origin" ? (reply.result.url ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** The project whose `origin` is the same repository as `url`, on the machine `client` reaches. */
export async function projectWithOrigin(
  client: ClientApi,
  url: string,
): Promise<string | undefined> {
  try {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op: "workspaces.match", url },
    });
    return reply.result.kind === "match" ? (reply.result.workspaceId ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}
