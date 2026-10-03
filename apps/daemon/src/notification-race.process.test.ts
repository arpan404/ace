import { WebSocket } from "ws";
import { DeviceId, Notification } from "@ace/protocol";
import { expect, it, vi } from "vitest";
import { fixture, token } from "./socket-test-support.ts";

it("disconnect during hello leaves no closed socket in notification delivery ownership", async () => {
  let enter: (() => void) | undefined, finish: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let disconnected: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const f = await fixture({
    onDisconnect: () => disconnected?.(),
    notifications: {
      async connectDevice() {
        enter?.();
        await gate;
      },
      async disconnect() {},
      async updatePresence() {},
      async register() {},
      async preferences() {},
      async snooze() {},
    },
  });
  try {
    const client = await f.open();
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });
    await entered;
    await client.close();
    await closed;
    finish?.();
    // A live second client is an event-driven barrier for the resolved authentication handler.
    const barrier = await f.connect();
    await barrier.next();
    await barrier.close();
    const getter = Object.getOwnPropertyDescriptor(WebSocket.prototype, "readyState")?.get;
    if (!getter) throw new Error("Missing socket state accessor");
    const spy = vi.spyOn(WebSocket.prototype, "readyState", "get").mockImplementation(function (
      this: WebSocket,
    ) {
      const state: unknown = getter.call(this);
      if (state === WebSocket.CLOSED) throw new Error("Notification visited a disconnected socket");
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING || state === WebSocket.CLOSING)
        return state;
      return WebSocket.CLOSED;
    });
    try {
      expect(
        f.server.notify(
          DeviceId.parse("device"),
          Notification.parse({
            id: "n",
            threadId: f.thread.id,
            title: "Safe",
            status: "done",
            actions: [],
            backgroundCount: 0,
          }),
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  } finally {
    finish?.();
    await f.close();
  }
});
