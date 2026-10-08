import type { ClientApi } from "@ace/client";
import type { CatalogEntry, CatalogList } from "@ace/protocol";
import type { z } from "zod";

type Target = Pick<z.input<typeof CatalogList>, "threadId" | "draft" | "workspace">;

/** One bounded discovery subscription, shared by the composer and Skills. */
export function watchCatalog(
  client: ClientApi,
  target: Target,
  receive: (entries: readonly CatalogEntry[]) => void,
  failed: () => void,
): () => void {
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  const stop = client.onMessage((message) => {
    if (message.type === "catalog.changed" && message.requestId === requestId)
      receive(message.entries);
  });
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
}
