import { latest, native, until } from "./test-host.ts";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import type { HostEntries } from "@ace/native-host";

/*
 * Reload from machine through the bridge's own entry points, as Swift drives them: `aceStart`
 * with the machine's config, then `aceAction` for opening the thread, staging a file and
 * reloading. The socket reaches the fake daemon; no provider CLI runs.
 */

// The bridge's entry module: it installs `aceStart`, `aceAction`, `aceAck` and `aceSocket`.
await import("./main.ts");

const daemon = new FakeDaemon({
  clock: Date.now,
  hostId: "ios-test-host",
  token: "ios-test-token",
});
daemon.createThread({ id: "files", workspaceId: "ace", title: "Files", provider: "codex" });
daemon.apply("files", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);

const entries = globalThis as unknown as HostEntries;
const sent: string[] = [];
// Swift acknowledges each frame the bridge emits through `aceAck`.
native.ack = (accepted) => entries.aceAck(accepted);
const sockets = new Map<string, ReturnType<typeof fakeTransport>>();
native.socket = (id, action, value) => {
  if (action === "open") {
    const transport = fakeTransport(daemon);
    sockets.set(id, transport);
    transport.open({
      open: () => entries.aceSocket(id, "open", ""),
      message: (text) => entries.aceSocket(id, "message", text),
      binary: (bytes) => entries.aceSocket(id, "binary", bytes),
      close: (code) => entries.aceSocket(id, "close", String(code)),
    });
  } else if (action === "send") {
    sent.push(value);
    sockets.get(id)?.send(value);
  } else sockets.get(id)?.close();
};

const photo = Buffer.alloc(120 * 1024, 4);
// The second chunk waits until the thread has been reloaded.
const { promise: reloaded, resolve: reloadedNow } = Promise.withResolvers<void>();
const answers: Record<string, string> = {
  credential: JSON.stringify({ token: "ios-test-token" }),
  "storage.records": "[]",
  "snapshot.index": "[]",
  "snapshot.size": "0",
};
for (const operation of [
  "storage.load",
  "storage.save",
  "storage.host.load",
  "storage.host.save",
  "storage.write",
  "storage.reads.load",
  "storage.reads.save",
  "storage.devices.load",
  "storage.devices.save",
  "inbox.checkpoint",
  "snapshot.get",
  "snapshot.set",
  "snapshot.thread.get",
  "snapshot.thread.put",
  "snapshot.drop",
  "snapshot.clear",
  "credential",
  "storage.records",
  "snapshot.index",
  "snapshot.size",
])
  native.calls.set(operation, () => answers[operation] ?? "");
native.calls.set("attachment.chunk", async (input) => {
  const { offset, limit } = input as { offset: number; limit: number };
  if (offset > 0) await reloaded;
  return photo.subarray(offset, offset + limit).toString("base64");
});

const action = (value: unknown) => entries.aceAction(JSON.stringify(value));
const tray = () =>
  latest("thread.attachments") as { files: { id: string; state: string }[] } | undefined;
const sends = () =>
  sent.flatMap((text) => {
    const message = JSON.parse(text) as { type?: string; command?: { payload?: unknown } };
    const payload = message.command?.payload as { type?: string; context?: unknown } | undefined;
    return message.type === "command" && payload?.type === "thread.send" ? [payload] : [];
  });

test("Reload from machine keeps a file still uploading on the message, through the bridge's entry points", async () => {
  entries.aceStart(
    JSON.stringify({ deviceId: "ios-main-test", hostId: "ios-test-host", itemLimit: 400 }),
  );
  // The socket opens and the daemon welcomes the phone; a loaded machine can take a while.
  for (let wait = 0; wait < 10 && latest("connection")?.state !== "ready"; wait++)
    await new Promise((resolve) => setTimeout(resolve, 500));
  expect(latest("connection")?.state).toBe("ready");
  action({ type: "open", threadId: "files" });
  await until(() => latest("thread.ready")?.epoch === 1);
  action({
    type: "thread",
    epoch: 1,
    action: {
      type: "attach",
      file: {
        localId: "photo-main-0001",
        name: "screen.png",
        mimeType: "image/png",
        bytes: photo.length,
        sha256: createHash("sha256").update(photo).digest("hex"),
      },
    },
  });
  await until(() => tray()?.files[0]?.state === "uploading");

  // Swift moves to the next generation and asks the bridge to reload the open thread.
  action({ type: "cache.reload", threadId: "files" });
  await until(() => latest("thread.ready")?.epoch === 2);
  reloadedNow();
  await until(() => tray()?.files[0]?.state === "ready");
  action({
    type: "thread",
    epoch: 2,
    action: { type: "send", text: "And now?", opposite: false, requestId: "main-send" },
  });
  await until(() => sends().length === 1);
  expect(sends()[0]?.context).toMatchObject({
    attachments: [{ sha256: createHash("sha256").update(photo).digest("hex") }],
  });
});
