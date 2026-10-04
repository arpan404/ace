import { afterEach, expect, test } from "vitest";
import { DevicesService, DevicePlatform } from "@ace/devices";
import { setup, ready, when } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
function deviceService() {
  return new DevicesService({
    platform: new DevicePlatform({ platform: "linux", home: "/unused", env: {} }),
    runtime: {
      now: () => 0,
      id: () => "device",
      spawn() {
        throw new Error("No process expected");
      },
      after() {
        throw new Error("No timer expected");
      },
    },
    env: {},
    recordingDirectory: "/unused",
    publishArtifact: async (artifact) => artifact,
  });
}

test("daemon capacity is a retryable client limit and a freed slot recovers after backoff", async () => {
  const devices = deviceService();
  const released = Promise.withResolvers<void>();
  const watch = devices.watch.bind(devices);
  devices.watch = (listener) => {
    const stop = watch(listener);
    return () => {
      stop();
      released.resolve();
    };
  };
  cleanups.push(() => devices.close());
  const f = await setup(undefined, undefined, undefined, devices);
  cleanups.push(() => f.cleanup());
  const admitted = [];
  for (let i = 0; i < 64; i++) {
    const peer = f.make();
    await ready(peer.client);
    admitted.push(peer.client);
  }
  const { client, scheduler } = f.make({ random: () => 0 });
  const limited = when(
    client.connectionState(),
    (state) => state === "reconnecting" || state === "fatal",
  );
  await client.start();
  expect(await limited).toBe("reconnecting");
  expect(client.error?.code).toBe("limit");
  await admitted[0]?.close();
  await released.promise;
  scheduler.advance(4999);
  expect(client.state).toBe("reconnecting");
  expect(client.error?.code).toBe("limit");
  const recovered = when(
    client.connectionState(),
    (state) => state === "ready" || state === "fatal",
  );
  scheduler.advance(1);
  expect(await recovered).toBe("ready");
  expect(client.error).toBeUndefined();
});

test("transient daemon service admission failure reconnects instead of becoming a protocol failure", async () => {
  const devices = deviceService();
  cleanups.push(() => devices.close());
  const watch = devices.watch.bind(devices);
  let unavailable = true;
  devices.watch = (listener) => {
    if (unavailable) {
      unavailable = false;
      throw new Error("temporarily unavailable");
    }
    return watch(listener);
  };
  const f = await setup(undefined, undefined, undefined, devices);
  cleanups.push(() => f.cleanup());
  const { client, scheduler } = f.make({ random: () => 0.5 });
  const failed = when(
    client.connectionState(),
    (state) => state === "reconnecting" || state === "fatal",
  );
  await client.start();
  expect(await failed).toBe("reconnecting");
  expect(client.error).toBeUndefined();
  const recovered = when(
    client.connectionState(),
    (state) => state === "ready" || state === "fatal",
  );
  scheduler.advance(124);
  expect(client.state).toBe("reconnecting");
  scheduler.advance(1);
  expect(await recovered).toBe("ready");
});
