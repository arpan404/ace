import { useCallback } from "react";
import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import type { ForgePrDetail, ForgeRepository } from "@ace/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { readForge } from "./source.ts";

/** How long a PR's detail counts as current before a view reads it again. */
export const prDetailStaleMs = 15_000;
/**
 * How long a PR's commits, timeline and changed files count as current. Their keys name the
 * head (and base or update time) the detail last saw, so any change the detail's own polling
 * finds is a new key, read at once: switching tabs never reads them again in between.
 */
export const prContentStaleMs = 10 * 60_000;

/**
 * The PR panel's detail read, shared by the panel and by anything that warms it before the
 * panel opens. The repository is reduced to the fields a tab keeps, so every caller names the
 * same query.
 */
export function prDetailKey(
  workspaceId: string,
  repository: ForgeRepository | undefined,
  number: number,
) {
  const subject = repository && {
    forge: repository.forge,
    host: repository.host,
    owner: repository.owner,
    name: repository.name,
  };
  return ["forge", workspaceId, subject, "pr", number] as const;
}

export async function readPrDetail(
  client: ClientApi,
  pr: { workspaceId: string; repository: ForgeRepository | undefined; number: number },
  signal: AbortSignal,
): Promise<ForgePrDetail> {
  const result = await readForge(
    client,
    {
      op: "forge.pr.detail",
      workspaceId: pr.workspaceId,
      repository: pr.repository,
      number: pr.number,
    },
    signal,
  );
  if (result.resource !== "prDetail") throw new Error("No pull request detail.");
  return result.value;
}

/**
 * Warm a PR's detail when someone is about to open it (a hover or focus on its row), so the panel
 * opens on it. Nothing happens offline or while a current read is already cached.
 */
export function usePrPrefetch(workspaceId: string | undefined) {
  const client = useClient();
  const queries = useQueryClient();
  const ready = useConnectionState() === "ready";
  return useCallback(
    (repository: ForgeRepository | undefined, number: number) => {
      if (!ready || !workspaceId) return;
      const pr = { workspaceId, repository, number };
      void queries.prefetchQuery({
        queryKey: prDetailKey(workspaceId, repository, number),
        queryFn: ({ signal }) => readPrDetail(client, pr, signal),
        meta: { daemonClient: client },
        staleTime: prDetailStaleMs,
        gcTime: keptForgeMs,
        retry: false,
      });
    },
    [client, queries, ready, workspaceId],
  );
}
