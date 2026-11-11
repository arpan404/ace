import { useSidebarThread, useThreadMeta } from "@ace/client-react";
import { useDaemonQuery } from "./daemon-query.ts";

/**
 * Spade's host thread on this machine (ADR 0121), from `spade.status`: the hidden thread the
 * threads Spade delegates name as their parent. Undefined while unknown or when Spade has none.
 */
export function useSpadeHostThread(): string | undefined {
  const query = useDaemonQuery({
    queryKey: ["spade", "host-thread"],
    staleTime: 60_000,
    read: async (client, signal) =>
      (await client.request({ type: "spade.status" }, { signal })).status.thread?.id ?? null,
  });
  return query.data ?? undefined;
}

/**
 * The parent a delegated thread links back to: none when Spade delegated it, since its parent
 * is Spade's hidden host thread, which the person can't open or send to.
 */
export function visibleParent(
  delegatedBy: string | undefined,
  spadeHost: string | undefined,
): string | undefined {
  return delegatedBy !== undefined && delegatedBy !== spadeHost ? delegatedBy : undefined;
}

/**
 * `visibleParent` for a thread's recorded parent. A parent the Threads list doesn't hold is read
 * itself, so a host thread is known by its own `host` field even when `spade.status` can't say.
 */
export function useVisibleParent(delegatedBy: string | undefined): string | undefined {
  const host = useSpadeHostThread();
  const listed = useSidebarThread(delegatedBy ?? "");
  const unlisted = useThreadMeta(delegatedBy !== undefined && !listed ? delegatedBy : undefined);
  if (unlisted?.host !== undefined) return undefined;
  return visibleParent(delegatedBy, host);
}
