import { useDaemonQuery } from "./daemon-query.ts";

/*
 * The same repository on two machines (ADR 0102): project ids belong to one daemon, so a
 * checkout is matched across machines by its `origin`, the way a transfer reuses one.
 */

/** The project's `origin` fetch URL on this machine; undefined while unread or without one. */
export function useProjectOrigin(project: string | undefined): string | undefined {
  const query = useDaemonQuery({
    queryKey: ["daemon", "project-origin", project],
    enabled: !!project,
    staleTime: 60_000,
    retry: false,
    read: async (client, signal) => {
      if (!project) return null;
      const reply = await client.request(
        { type: "workspace.request", operation: { op: "workspace.origin", workspaceId: project } },
        { signal },
      );
      const result = reply.result;
      if (result.kind === "error") throw new Error(result.code);
      if (result.kind !== "origin") throw new Error("ace didn't read the project's origin.");
      return result.url;
    },
  });
  return query.data ?? undefined;
}

export type OriginMatch =
  | { state: "idle" }
  | { state: "matching" }
  | { state: "matched"; project: string }
  | { state: "none" };

/** This machine's project whose `origin` is the same repository as `url`. */
export function useOriginMatch(url: string | undefined): OriginMatch {
  const query = useDaemonQuery({
    queryKey: ["daemon", "origin-match", url],
    enabled: !!url,
    staleTime: 0,
    retry: false,
    read: async (client, signal) => {
      if (!url) return null;
      const reply = await client.request(
        { type: "workspace.request", operation: { op: "workspaces.match", url } },
        { signal },
      );
      const result = reply.result;
      if (result.kind === "error") throw new Error(result.code);
      if (result.kind !== "match") throw new Error("ace didn't look for the project.");
      return result.workspaceId;
    },
  });
  if (!url) return { state: "idle" };
  // A daemon that can't answer (an older one, or offline) has no copy to offer.
  if (query.error) return { state: "none" };
  if (query.data === undefined) return { state: "matching" };
  return query.data ? { state: "matched", project: query.data } : { state: "none" };
}
