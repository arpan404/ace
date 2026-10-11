import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientCore, type Storage, type TransportEvents } from "@ace/client";
import { ClientMessage, DeviceId, ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { notificationOutbox } from "./notification-outbox.ts";

function client(storage: Storage) {
  let socket: TransportEvents | undefined;
  const commands: string[] = [];
  const core = new ClientCore({
    deviceId: DeviceId.parse("device"),
    storage,
    transport: () => ({
      open(events) {
        socket = events;
      },
      send(text) {
        const message = ClientMessage.parse(JSON.parse(text));
        if (message.type === "command") commands.push(message.command.id);
      },
      close() {},
    }),
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => "generated",
    credential: async () => "a".repeat(64),
  });
  return {
    core,
    commands,
    welcome: (hostId: string) =>
      socket?.message(JSON.stringify({ type: "welcome", hostId, protocolVersion: 1, headSeq: 0 })),
  };
}

for (const replacement of ["same-host", "different-home", "different-url"]) {
  test(`notification recovery on ${replacement} preserves daemon ownership`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-notification-outbox-"));
    const url = "ws://localhost:4242";
    try {
      const first = client(notificationOutbox(root, url, "device"));
      await first.core.start();
      first.welcome("host-a");
      first.core.networkOnline(false);
      await first.core.enqueue(
        { type: "thread.archive", threadId: ThreadId.parse("thread") },
        "original-action",
      );
      await first.core.close();
      const next = client(
        notificationOutbox(
          root,
          replacement === "different-url" ? "ws://localhost:4243" : url,
          "device",
        ),
      );
      await next.core.start();
      next.welcome(replacement === "same-host" ? "host-a" : "host-b");
      await next.core
        .enqueue({ type: "thread.archive", threadId: ThreadId.parse("barrier") }, "barrier")
        .catch(() => {});
      if (replacement === "same-host") expect(next.commands).toContain("original-action");
      else expect(next.commands).not.toContain("original-action");
      if (replacement === "different-home") expect(next.core.state).toBe("fatal");
      await next.core.close();
      expect(await notificationOutbox(root, url, "device").load()).toContain("original-action");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("legacy notification actions remain recoverable and are never assigned to a newly selected host", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-notification-legacy-"));
  try {
    const legacy = JSON.stringify([
      {
        command: {
          id: "legacy",
          deviceId: DeviceId.parse("device"),
          payload: { type: "thread.archive", threadId: ThreadId.parse("thread") },
        },
        state: "pending",
      },
    ]);
    await writeFile(join(root, "outbox.json"), legacy);
    const next = client(notificationOutbox(root, "ws://localhost:4242", "device"));
    await next.core.start();
    next.welcome("host-b");
    await next.core.enqueue(
      { type: "thread.archive", threadId: ThreadId.parse("barrier") },
      "barrier",
    );
    expect(next.commands).not.toContain("legacy");
    expect(await readFile(join(root, "outbox.json"), "utf8")).toBe(legacy);
    await next.core.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
