import { expect, test } from "vitest";
import { chunkFilesChannel } from "./index.ts";
import { fixture } from "./test-support.ts";
import { ThreadId, type FileOperation, type FilesServerMessage } from "@ace/protocol";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A chunk channel over a real checkout whose resolve can be held for chosen operations. */
async function harness(held: (operation: FileOperation | undefined) => boolean) {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const messages: FilesServerMessage[] = [];
  const waiters: { test(m: FilesServerMessage): boolean; resolve(m: FilesServerMessage): void }[] =
    [];
  const channel = chunkFilesChannel({
    device: "viewer",
    async resolve(_thread, _scope, operation) {
      if (held(operation)) {
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
  const reply = (requestId: string) => {
    const match = (m: FilesServerMessage) => "requestId" in m && m.requestId === requestId;
    const found = messages.find(match);
    return found
      ? Promise.resolve(found)
      : new Promise<FilesServerMessage>((resolve) => waiters.push({ test: match, resolve }));
  };
  const request = (requestId: string, operation: FileOperation) =>
    channel.accept({
      type: "files.request",
      threadId: ThreadId.parse("thread"),
      requestId,
      operation,
    });
  return { f, gate, entered, messages, channel, reply, request };
}

test("a file opens and reads while a slow tree listing is still running", async () => {
  const h = await harness((operation) => operation?.op === "list");
  await writeFile(join(h.f.root, "small.ts"), "export const answer = 42;\n");
  try {
    h.request("listing", { op: "list", path: "", limit: 1000 });
    await h.entered.promise;
    h.request("stat", { op: "stat", path: "small.ts" });
    expect(await h.reply("stat")).toMatchObject({ type: "files.result" });
    h.request("open", { op: "download", path: "small.ts", offset: 0 });
    const ready = await h.reply("open");
    expect(ready.type).toBe("files.ready");
    if (ready.type !== "files.ready") return;
    h.channel.accept({ type: "files.pull", requestId: "pull", channel: ready.channel });
    const data = await h.reply("pull");
    expect(data.type === "files.data" && Buffer.from(data.data, "base64").toString()).toBe(
      "export const answer = 42;\n",
    );
    expect(h.messages.some((m) => "requestId" in m && m.requestId === "listing")).toBe(false);
    h.gate.resolve();
    expect(await h.reply("listing")).toMatchObject({ type: "files.result" });
  } finally {
    h.gate.resolve();
    h.channel.close();
    await h.f.close();
  }
});

test("a read sent after a write sees the written file", async () => {
  const h = await harness((operation) => operation?.op === "create");
  try {
    h.request("create", { op: "create", path: "new.ts", expected: null, text: "" });
    await h.entered.promise;
    h.request("stat", { op: "stat", path: "new.ts" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.messages.some((m) => "requestId" in m && m.requestId === "stat")).toBe(false);
    h.gate.resolve();
    expect(await h.reply("create")).toMatchObject({ type: "files.result" });
    const stat = await h.reply("stat");
    expect(stat.type === "files.result" && stat.value).toMatchObject({ path: "new.ts" });
    expect(stat.type === "files.result" && stat.value).not.toMatchObject({ version: null });
  } finally {
    h.gate.resolve();
    h.channel.close();
    await h.f.close();
  }
});
