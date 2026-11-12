import { once } from "node:events";
import { WebSocket } from "ws";
import { ServerMessage } from "@ace/protocol";

/**
 * A client that keeps the thread list subscribed and opens each finished thread once, then
 * closes it, as a person clicking through new threads in the desktop would. Without it the
 * soak never reaches the daemon's read paths (thread views, list windows, fan-out). With
 * `settle`, each opened thread is settled too, so the Inbox (which lists every unsettled
 * thread) stays the size a person keeps instead of growing with every cycle.
 */
export async function soakReader(endpoint: string, token: string, settle: boolean) {
  const socket = new WebSocket(endpoint.replace("http:", "ws:"));
  await once(socket, "open");
  const waiting = new Map<string, () => void>();
  const welcomed = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  socket.on("message", (bytes: Buffer) => {
    const message = ServerMessage.parse(JSON.parse(bytes.toString()));
    if (message.type === "welcome") welcomed.resolve();
    if (message.type === "commandResult") {
      if (!message.ok) failed.reject(new Error(JSON.stringify(message)));
      waiting.get(message.commandId)?.();
      waiting.delete(message.commandId);
    }
    // A large list arrives in parts; the last part completes it as a snapshot would.
    if (message.type === "snapshot" || (message.type === "snapshot.part" && message.done)) {
      waiting.get(message.subscriptionId)?.();
      waiting.delete(message.subscriptionId);
    }
    if (message.type === "error") failed.reject(new Error(JSON.stringify(message)));
  });
  socket.send(
    JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: "perf-reader", token }),
  );
  await Promise.race([welcomed.promise, failed.promise]);
  const subscribe = async (subscriptionId: string, scope: unknown) => {
    const ready = new Promise<void>((resolve) => waiting.set(subscriptionId, resolve));
    socket.send(JSON.stringify({ type: "subscribe", subscriptionId, scope }));
    await Promise.race([ready, failed.promise]);
  };
  await subscribe("list", { kind: "threads", window: { limit: 20 } });
  return {
    async open(threads: readonly string[]) {
      for (const threadId of threads) {
        await subscribe(`thread-${threadId}`, { kind: "thread", threadId });
        socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId: `thread-${threadId}` }));
        if (!settle) continue;
        // Unique across connections: the daemon answers a repeated command id from its record.
        const id = `settle-${threadId}`;
        const done = new Promise<void>((resolve) => waiting.set(id, resolve));
        const payload = { type: "thread.settle", threadId };
        socket.send(
          JSON.stringify({ type: "command", command: { id, deviceId: "perf-reader", payload } }),
        );
        await Promise.race([done, failed.promise]);
      }
    },
    async close() {
      socket.close();
      await once(socket, "close");
    },
  };
}
