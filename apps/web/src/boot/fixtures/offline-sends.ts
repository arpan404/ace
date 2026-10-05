import { ThreadId, type CommandPayload } from "@ace/protocol";
import { createBrowserClient } from "../client.ts";
import { workerOutbox } from "../worker-outbox.ts";

/*
 * Browser entry for `worker-outbox.test.ts`: real clients on the client worker's outbox, with a
 * daemon that never answers, as two workers saving offline sends would be.
 */

const target = { url: "ws://127.0.0.1:9/never", deviceId: "device", seed: null };

function offlineClient() {
  return createBrowserClient({
    deviceId: target.deviceId,
    // Nothing listens there: the client stays offline and keeps its sends in the outbox.
    transport: () => {
      throw new Error("offline");
    },
    credential: async () => "token",
    storage: workerOutbox(target),
  });
}

const send = (text: string): CommandPayload => ({
  type: "thread.send",
  threadId: ThreadId.parse("thread"),
  input: [{ type: "text", text }],
});

/** Two clients, started together on one outbox, each save a different send while offline. */
export async function twoWorkersSend(): Promise<void> {
  const a = offlineClient();
  const b = offlineClient();
  await Promise.all([a.start(), b.start()]);
  await Promise.all([a.enqueue(send("from a"), "send-a"), b.enqueue(send("from b"), "send-b")]);
  await Promise.all([a.close(), b.close()]);
}

/** What a client starting afterwards (a reload) still has waiting to send. */
export async function afterReload(): Promise<string[]> {
  const client = offlineClient();
  await client.start();
  const waiting = client.pendingSends().getSnapshot().map((entry) => entry.commandId);
  await client.close();
  return waiting.toSorted();
}
