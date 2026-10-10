import { watchCatalog } from "@/lib/catalog.ts";
import type { ClientApi } from "@ace/client";
import { ThreadId, WorkspaceId, type CatalogEntry } from "@ace/protocol";
import type { ThreadRef } from "./workspace-source.ts";

export type CommandScope = Omit<ThreadRef, "title">;

export interface CommandSource {
  watch(
    thread: CommandScope,
    receive: (entries: readonly CatalogEntry[], stale: boolean) => void,
    failed: () => void,
  ): () => void;
}
export function daemonCommandSource(client: ClientApi): CommandSource {
  return {
    watch(thread, receive, failed) {
      const target =
        thread.draft && thread.provider
          ? {
              draft: {
                draftId: thread.id,
                workspaceId: WorkspaceId.parse(thread.workspaceId),
                provider: thread.provider,
                ...(thread.instanceId ? { instanceId: thread.instanceId } : {}),
              },
            }
          : { threadId: ThreadId.parse(thread.id) };
      return watchCatalog(client, target, receive, failed);
    },
  };
}
