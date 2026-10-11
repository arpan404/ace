import { expect, it, onTestFinished } from "vitest";
import { deviceControls } from "@ace/ui-core";
import { DeviceClient, type DeviceTransportEvents } from "./client.ts";
import { connectDevices, DevicePlatform, DevicesService } from "./index.ts";

const deviceId = "android:Pixel";
function controls(client: DeviceClient) {
  const state = client.getSnapshot().states.find((entry) => entry.device.id === deviceId);
  if (!state) throw new Error("Missing peer state");
  return deviceControls(state.device, state, "thread", 1000);
}
async function fixture() {
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [
    { id: deviceId, name: "Pixel", platform: "android", state: "booted" },
  ];
  const inputEntered = Promise.withResolvers<void>();
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const effects: number[] = [];
  // The SDK input boundary stands in for a native device unavailable to unit tests.
  platform.input = async (_device, input, _binding, guard) => {
    guard?.();
    if (input.kind === "tap") effects.push(input.x);
    inputEntered.resolve();
    await gate?.promise;
  };
  const service = new DevicesService({
    platform,
    env: {},
    recordingDirectory: "/unused",
    publishArtifact: async () => {},
    runtime: {
      now: () => 1000,
      id: () => "unused",
      after: () => () => {},
      spawn() {
        throw new Error("Unexpected native capture");
      },
    },
  });
  const clients: DeviceClient[] = [];
  const peer = (owner: string) => {
    let events: DeviceTransportEvents | undefined;
    let serial = 0;
    const client = new DeviceClient({ id: () => `${owner}-${++serial}`, schedule: () => () => {} });
    const channel = connectDevices(service, owner, {
      authorize: () => true,
      canReadThread: () => true,
      agentExists: () => true,
      async send(message) {
        events?.message(message);
      },
      async frame() {},
      async image() {},
    });
    client.connect({
      open(next) {
        events = next;
        next.ready();
      },
      send: (message) => channel.request(message),
      close: () => channel.close(),
    });
    clients.push(client);
    return client;
  };
  onTestFinished(async () => {
    gate?.resolve();
    for (const client of clients) client.disconnect();
    await service.close();
  });
  const a = peer("connection-A"),
    b = peer("connection-B");
  await a.request({ op: "enable", enabled: true });
  return {
    a,
    b,
    peer,
    controls,
    effects,
    inputEntered,
    holdInput() {
      gate = Promise.withResolvers<void>();
      return gate;
    },
  };
}

it("only the claiming connection shows human ownership and takeover transfers it", async () => {
  const f = await fixture();
  await f.a.request({ op: "controller", deviceId, controller: "human" });
  expect(f.controls(f.a).inControl).toBe(true);
  expect(f.controls(f.b).inControl).toBe(false);
  expect(f.controls(f.b).status).toBe("Running · Another connection is in control");
  await f.b.request({ op: "states" });
  expect(f.controls(f.b).inControl).toBe(false);
  await f.b.request({ op: "controller", deviceId, controller: "human" });
  expect(f.controls(f.b).inControl).toBe(true);
  expect(f.controls(f.a).inControl).toBe(false);
  await f.b.request({ op: "input", deviceId, input: { kind: "tap", x: 2, y: 0 } });
  expect(f.effects).toEqual([2]);
  // Closing another connection does not release B's lease.
  f.a.disconnect();
  expect(f.controls(f.b).inControl).toBe(true);
  const reconnected = f.peer("connection-A-reconnected");
  await reconnected.request({ op: "states" });
  expect(f.controls(reconnected).inControl).toBe(false);
});

it("takeover fences queued input from the previous human connection", async () => {
  const f = await fixture();
  await f.a.request({ op: "controller", deviceId, controller: "human" });
  const held = f.holdInput();
  const active = f.a.request({ op: "input", deviceId, input: { kind: "tap", x: 1, y: 0 } });
  const activeOutcome = active.catch((error: unknown) => error);
  await f.inputEntered.promise;
  const queued = f.a.request({ op: "input", deviceId, input: { kind: "tap", x: 2, y: 0 } });
  const rejected = expect(queued).rejects.toMatchObject({ code: "lease_required" });
  await f.b.request({ op: "controller", deviceId, controller: "human" });
  held.resolve();
  await Promise.all([activeOutcome, rejected]);
  await f.b.request({ op: "input", deviceId, input: { kind: "tap", x: 3, y: 0 } });
  expect(f.effects).toEqual([1, 3]);
  expect(f.controls(f.a).inControl).toBe(false);
  expect(f.controls(f.b).inControl).toBe(true);
});
