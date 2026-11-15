import { ClientCore, defaultLimits } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { expect, test } from "vitest";
import { manyActions } from "./many-actions.ts";
import { socketFrames } from "./socket-frames.ts";

/** A real SDK on the fixture's socket path: every frame the fixture sends goes through `socketFrames`. */
async function connected() {
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
  });
  const frames: number[] = [];
  const socket = {
    connect: (wire: Parameters<FakeDaemon["connect"]>[0]) =>
      daemon.connect({
        ...wire,
        send: (text) => {
          for (const frame of socketFrames(text)) {
            frames.push(Buffer.byteLength(frame));
            wire.send(frame);
          }
        },
      }),
  };
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-frames-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(socket),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  await owner.start();
  for (let wait = 0; wait < 200 && owner.state !== "ready"; wait++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return { daemon, owner, frames };
}

test("a pending approval's entity page over the phone's frame cap arrives whole, in frames the phone accepts", async () => {
  const { daemon, owner, frames } = await connected();
  manyActions(daemon, "ios-many-frames");
  frames.length = 0;

  const reply = await owner.request({
    type: "entities.page",
    threadId: "ios-many-frames",
    collection: "interactions",
    before: Number.MAX_SAFE_INTEGER,
    limit: 50,
  });

  const page = reply.page;
  expect(page.collection).toBe("interactions");
  const request = page.collection === "interactions" ? page.entries[0]?.request : undefined;
  expect(request?.kind === "approval" ? request.options.length : 0).toBe(300);
  expect(Math.max(...frames)).toBeLessThanOrEqual(defaultLimits.frameBytes);
  await owner.close();
});
