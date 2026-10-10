import type { ClientApi } from "@ace/client";

const queues = new WeakMap<ClientApi, Promise<void>>();
/** Leave workspace capacity for interactive reads; failed PR reads remain retryable. */
export function readPullRequest(client: ClientApi, threadId: string, signal: AbortSignal) {
  const previous = queues.get(client) ?? Promise.resolve();
  const read = previous.then(async () => {
    signal.throwIfAborted();
    const reply = await client.request(
      { type: "workspace.request", operation: { op: "pr.status", threadId } },
      { signal },
    );
    if (reply.result.kind === "error")
      throw new Error("Couldn't read this pull request. Try again.");
    return reply.result.kind === "pr" ? reply.result.status : null;
  });
  const drained = read.then(
    () => {},
    () => {},
  );
  queues.set(client, drained);
  void drained.then(() => {
    if (queues.get(client) === drained) queues.delete(client);
  });
  return read;
}
