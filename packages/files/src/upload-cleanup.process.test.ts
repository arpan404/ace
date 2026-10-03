import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ThreadId, type FilesServerMessage } from "@ace/protocol";
import { workspaceRuntime } from "@ace/workspace";
import { chunkFilesChannel } from "./index.ts";
import { fixture } from "./test-support.ts";

test("upload cancellation drains a started append before releasing capacity and never acknowledges late bytes", async () => {
  const runtime = workspaceRuntime();
  const filesystem = runtime.filesystem;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  runtime.filesystem = {
    ...filesystem,
    async realpath(path) {
      if (hold) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      return filesystem.realpath(path);
    },
  };
  const f = await fixture({ workspaceRuntime: runtime, maxTransfers: 1 });
  await writeFile(join(f.root, "barrier"), "unrelated read");
  const messages: FilesServerMessage[] = [];
  const waiters: {
    match(message: FilesServerMessage): boolean;
    resolve(message: FilesServerMessage): void;
  }[] = [];
  const channel = chunkFilesChannel({
    device: "writer",
    resolve: async () => ({ service: f.service, allowed: () => true }),
    send(message) {
      messages.push(message);
      for (const waiter of waiters.slice())
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
    },
  });
  const wait = (match: (message: FilesServerMessage) => boolean) => {
    const found = messages.find(match);
    return found
      ? Promise.resolve(found)
      : new Promise<FilesServerMessage>((resolve) => waiters.push({ match, resolve }));
  };
  try {
    channel.accept({
      type: "files.request",
      requestId: "begin",
      threadId: ThreadId.parse("thread"),
      operation: { op: "upload.begin", path: "target", size: 3, expected: null },
    });
    const upload = await wait((m) => "requestId" in m && m.requestId === "begin");
    expect(upload.type).toBe("files.upload");
    if (upload.type !== "files.upload") throw new Error("Upload did not open");
    hold = true;
    channel.accept({
      type: "files.chunk",
      requestId: "append",
      channel: upload.channel,
      offset: 0,
      data: Buffer.from("abc").toString("base64"),
    });
    // The append passed authorization and is waiting at a real filesystem boundary.
    await entered.promise;
    channel.accept({ type: "files.cancel", channel: upload.channel });
    // An independent read settles while the mutation remains held, without timer guesses.
    await f.service.request("writer", { op: "stat", path: "barrier" });
    expect(messages.some((m) => m.type === "files.cancelled")).toBe(false);
    expect(() => {
      const free = f.service.reserve();
      free();
    }).toThrow(expect.objectContaining({ code: "BUSY" }));
    release.resolve();
    expect(await wait((m) => m.type === "files.cancelled")).toMatchObject({
      channel: upload.channel,
    });
    // A subsequent queued request is a barrier after the completed append handler.
    channel.accept({
      type: "files.request",
      requestId: "after",
      threadId: ThreadId.parse("thread"),
      operation: { op: "stat", path: "barrier" },
    });
    await wait((m) => "requestId" in m && m.requestId === "after");
    expect(messages.some((m) => m.type === "files.upload" && m.requestId === "append")).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "files.error", requestId: "append", code: "ABORTED" }),
    );
    const free = f.service.reserve();
    free();
    // Cancellation closes transport ownership, while durable bytes remain resumable.
    expect(
      await f.service.request("writer", { op: "upload.resume", uploadId: upload.uploadId }),
    ).toMatchObject({ offset: 3, size: 3 });
  } finally {
    release.resolve();
    channel.close();
    await f.close();
  }
});
