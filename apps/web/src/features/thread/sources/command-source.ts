import type { ClientApi } from "@ace/client";
import { ThreadId, WorkspaceId, type CatalogEntry } from "@ace/protocol";
import type { ThreadRef } from "./workspace-source.ts";

export interface CommandSource {
  watch(
    thread: ThreadRef,
    receive: (entries: readonly CatalogEntry[]) => void,
    failed: () => void,
  ): () => void;
}
export function daemonCommandSource(client: ClientApi): CommandSource {
  return {
    watch(thread, receive, failed) {
      const requestId = crypto.randomUUID();
      const controller = new AbortController();
      const stop = client.onMessage((message) => {
        if (message.type === "catalog.changed" && message.requestId === requestId)
          receive(message.entries);
      });
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
      void client
        .request(
          { type: "catalog.list", ...target, subscribe: true, limit: 512 },
          { requestId, signal: controller.signal },
        )
        .then(
          (reply) => {
            if (!controller.signal.aborted) receive(reply.entries);
          },
          () => {
            if (!controller.signal.aborted) failed();
          },
        );
      return () => {
        controller.abort();
        stop();
        if (client.state === "ready") client.send({ type: "catalog.unsubscribe", requestId });
      };
    },
  };
}
