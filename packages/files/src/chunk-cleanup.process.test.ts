import { expect, test } from "vitest";
import { chunkFilesChannel } from "./index.ts";
import { fixture } from "./test-support.ts";
import { ThreadId, type FilesServerMessage } from "@ace/protocol";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("abort invalidates a queued opening even when normal controls are saturated", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "source"), "data");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const messages: FilesServerMessage[] = [];
  const waiters: {
    test(message: FilesServerMessage): boolean;
    resolve(message: FilesServerMessage): void;
  }[] = [];
  let hold = true;
  const channel = chunkFilesChannel({
    device: "writer",
    async resolve() {
      if (hold) {
        entered.resolve();
        await gate.promise;
      }
      return { service: f.service, allowed: () => true };
    },
    send(message) {
      messages.push(message);
      for (const waiter of waiters.slice())
        if (waiter.test(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
    },
  });
  const wait = (predicate: (message: FilesServerMessage) => boolean) => {
    const found = messages.find(predicate);
    return found
      ? Promise.resolve(found)
      : new Promise<FilesServerMessage>((resolve) => waiters.push({ test: predicate, resolve }));
  };
  const request = (requestId: string, op: "download" | "stat") =>
    channel.accept({
      type: "files.request",
      threadId: ThreadId.parse("thread"),
      requestId,
      operation: op === "download" ? { op, path: "source", offset: 0 } : { op, path: "source" },
    });
  try {
    request("abandoned", "download");
    await entered.promise;
    for (let i = 0; i < 7; i++) request(`queued-${i}`, "stat");
    channel.accept({ type: "files.abort", sourceRequestId: "abandoned" });
    hold = false;
    gate.resolve();
    await wait((m) => "requestId" in m && m.requestId === "queued-6");
    expect(messages.some((m) => m.type === "files.ready" && m.requestId === "abandoned")).toBe(
      false,
    );
    const opened: number[] = [];
    for (let i = 0; i < 4; i++) {
      request(`open-${i}`, "download");
      const result = await wait((m) => "requestId" in m && m.requestId === `open-${i}`);
      expect(result.type).toBe("files.ready");
      if (result.type === "files.ready") opened.push(result.channel);
    }
    // Fill the queue synchronously before any control can drain, then dismiss a channel.
    for (let i = 0; i < 8; i++) request(`busy-${i}`, "stat");
    channel.accept({ type: "files.cancel", channel: opened[0] });
    expect(await wait((m) => m.type === "files.cancelled")).toMatchObject({
      type: "files.cancelled",
      channel: opened[0],
    });
    await wait((m) => "requestId" in m && m.requestId === "busy-6");
    request("replacement", "download");
    expect(await wait((m) => "requestId" in m && m.requestId === "replacement")).toMatchObject({
      type: "files.ready",
    });
  } finally {
    gate.resolve();
    channel.close();
    await f.close();
  }
});
