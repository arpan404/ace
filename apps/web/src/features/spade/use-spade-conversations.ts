import type { ClientApi } from "@ace/client";
import { parseSpadeConversations, type SpadeConversationRow } from "@ace/ui-core/spade-chat";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { spadeHttp } from "./spade-requests.ts";

export const conversationsKey = ["spade", "conversations"] as const;

async function readConversations(client: ClientApi, signal: AbortSignal) {
  const rows = parseSpadeConversations(
    await spadeHttp(client, "GET", "/v1/conversations", { signal }),
  );
  if (!rows) throw new Error("Spade's conversation list didn't make sense.");
  return rows;
}

/**
 * Spade's conversations, newest first. Spade has no stream for its list, so it is read again
 * every few seconds while Spade runs, faster while any row works, so a reply or a job that
 * ends elsewhere never leaves its row reading as working.
 */
export function useSpadeConversations(ready: boolean) {
  return useDaemonQuery<SpadeConversationRow[]>({
    queryKey: conversationsKey,
    read: readConversations,
    enabled: ready,
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.answering || row.jobs > 0) ? 2_000 : 10_000,
  });
}
