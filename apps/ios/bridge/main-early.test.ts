import { latest, native, until } from "./test-host.ts";
import { expect, test } from "vitest";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import type { HostEntries } from "@ace/native-host";

/*
 * A thread opened at a cold launch, through the bridge's own entry points as Swift drives them:
 * native's actions reach `aceAction` before `aceStart` has made the client, and the daemon is
 * one that never answers a request it doesn't know (an older one). The thread still opens,
 * under native's own generation, and nothing raises the error alert.
 */

await import("./main.ts");

const daemon = new FakeDaemon({
  clock: Date.now,
  hostId: "ios-early-host",
  token: "ios-early-token",
});
daemon.createThread({ id: "early", workspaceId: "ace", title: "Early", provider: "codex" });
daemon.apply("early", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);

const entries = globalThis as unknown as HostEntries;
native.ack = (accepted) => entries.aceAck(accepted);
/** Requests an older daemon doesn't know: it never answers them. */
const unknownToDaemon = new Set(["settings.get"]);
const unanswered: string[] = [];
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
    const type = (() => {
      try {
        return (JSON.parse(value) as { type?: unknown }).type;
      } catch {
        return undefined;
      }
    })();
    if (typeof type === "string" && unknownToDaemon.has(type)) unanswered.push(type);
    else sockets.get(id)?.send(value);
  } else sockets.get(id)?.close();
};
const answers: Record<string, string> = {
  credential: JSON.stringify({ token: "ios-early-token" }),
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

const action = (value: unknown) => entries.aceAction(JSON.stringify(value));
const alerts = () => native.frames.filter((frame) => frame.type === "error");

test("a thread opened before the client starts opens once it does, under native's generation, with no alert", async () => {
  // Native opened another thread, went back and opened this one while the runtime booted: its
  // generation is 3. Its first-screen word and a Retry went out before the client too.
  action({ type: "open", threadId: "elsewhere", epoch: 1 });
  action({ type: "back", epoch: 2 });
  action({ type: "open", threadId: "early", epoch: 3 });
  action({ type: "thread.shown", threadId: "early", epoch: 3 });
  action({ type: "retry" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(alerts()).toEqual([]);

  entries.aceStart(
    JSON.stringify({ deviceId: "ios-early-test", hostId: "ios-early-host", itemLimit: 400 }),
  );
  for (let wait = 0; wait < 10 && latest("connection")?.state !== "ready"; wait++)
    await new Promise((resolve) => setTimeout(resolve, 500));
  expect(latest("connection")?.state).toBe("ready");
  // The first screen comes under generation 3, the one native is drawing.
  await until(() => latest("thread.ready")?.epoch === 3);
  // The daemon never answered what it doesn't know; the open didn't wait on it, nor alert.
  await until(() => unanswered.includes("settings.get"));
  expect(alerts()).toEqual([]);
});
