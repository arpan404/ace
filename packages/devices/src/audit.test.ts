import { expect, it } from "vitest";
import {
  ControllerLease,
  DeviceStreamControl,
  DeviceLogs,
  deviceControlDelivery,
} from "./index.ts";
import { SimulatorFrames } from "./simulator-frames.ts";
import { InventoryWatch } from "./inventory.ts";
import type { DeviceServerMessage } from "@ace/protocol/devices";

function clock() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  return {
    now: () => now,
    after(ms: number, run: () => void) {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers)
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
    },
  };
}
const human = { kind: "human", owner: "viewer" } as const;
it("an operation lasting four minutes keeps control and takeover still fences it", () => {
  const time = clock();
  const lease = new ControllerLease(time.now);
  lease.claim(human);
  const ticket = lease.ticket(human);
  const release = lease.retain(human, ticket);
  time.advance(240000);
  expect(() => lease.assert(human, ticket)).not.toThrow();
  lease.claim({ kind: "human", owner: "next" });
  expect(() => lease.assert(human, ticket)).toThrow();
  release();
});
it("an expired agent delegation resumes but an explicit handback cannot resume", () => {
  const time = clock();
  const lease = new ControllerLease(time.now);
  const agent = { kind: "agent", owner: "agent", threadId: "thread", agentId: "agent" } as const;
  lease.claim(agent);
  time.advance(60000);
  expect(lease.resume(agent)).toBe(true);
  expect(() => lease.ticket(agent)).not.toThrow();
  lease.release();
  expect(lease.resume(agent)).toBe(false);
  lease.claim(human);
  expect(lease.resume(agent)).toBe(false);
});
it("identical stream budgets preserve the native capture and recording bounds its traffic", async () => {
  const effects: string[] = [];
  const control = new DeviceStreamControl(async (settings) => {
    effects.push(`${settings.codec}:${settings.maxWidth}x${settings.maxHeight}:${settings.fps}`);
    return { codec: settings.codec };
  });
  const profile = {
    codec: "h264" as const,
    maxWidth: 1920,
    maxHeight: 2160,
    fps: 60,
    bitrate: 4000000,
  };
  await control.set("a", profile);
  await control.set("b", { ...profile });
  await control.refresh();
  await control.remove("b");
  const recording = control.acquireRecording();
  await recording.ready;
  await recording.release();
  expect(effects).toEqual(["h264:1920x2160:60", "jpeg:1280x720:15", "h264:1920x2160:60"]);
  await control.close();
});
it("the final Simulator frame is published after throttling even when no more frames arrive", async () => {
  const time = clock();
  const frames: string[] = [];
  let ready = Promise.withResolvers<void>();
  const capture = new SimulatorFrames({
    fps: 30,
    ...time,
    failure(error) {
      throw error;
    },
    publish(image) {
      frames.push(image.bytes.toString());
      ready.resolve();
    },
  });
  capture.push(Buffer.from("before"), 100, 200);
  await ready.promise;
  ready = Promise.withResolvers<void>();
  time.advance(5);
  capture.push(Buffer.from("intermediate"), 100, 200);
  time.advance(5);
  capture.push(Buffer.from("after"), 100, 200);
  expect(frames).toEqual(["before"]);
  time.advance(24);
  await ready.promise;
  expect(frames).toEqual(["before", "after"]);
  await capture.stop();
  time.advance(1000);
  expect(frames).toEqual(["before", "after"]);
});
it("congested device pushes coalesce without losing replies or closing the connection", async () => {
  const time = clock();
  let buffered = 400000;
  const delivered: DeviceServerMessage[] = [];
  const delivery = deviceControlDelivery({
    ...time,
    bufferedBytes: () => buffered,
    async write(message) {
      delivered.push(message);
    },
    failure(error) {
      throw error;
    },
  });
  const state = {
    device: {
      id: "android:Pixel",
      name: "Pixel",
      platform: "android" as const,
      state: "booted" as const,
    },
    enabled: true,
    approved: false,
    lifecycle: "live" as const,
    controller: "none" as const,
  };
  await delivery.send({ type: "devices.state", state });
  await delivery.send({ type: "devices.state", state: { ...state, booting: true } });
  await delivery.send({
    type: "devices.result",
    requestId: "tap",
    ok: true,
    data: { completed: true },
  });
  expect(delivered.map((message) => message.type)).toEqual(["devices.result"]);
  time.advance(25);
  buffered = 0;
  time.advance(25);
  expect(delivered).toEqual([
    { type: "devices.result", requestId: "tap", ok: true, data: { completed: true } },
    { type: "devices.state", state: { ...state, booting: true } },
  ]);
  delivery.close();
});
it("a burst of iOS logs reaches the viewer in one bounded batch", async () => {
  const time = clock();
  const logs = new DeviceLogs(time.after);
  const ready = Promise.withResolvers<void>();
  const lines: string[][] = [];
  logs.subscribe(async (batch) => {
    lines.push(batch.lines);
    ready.resolve();
  });
  for (let i = 0; i < 50; i++)
    logs.push(
      JSON.stringify({
        eventMessage: `\u001b[32mlog ${i}\u001b[0m`,
        processImagePath: "/private/application/Example",
        timestamp: "2026-10-10 10:01:02",
        processID: 1234,
      }),
    );
  expect(lines).toEqual([]);
  time.advance(100);
  await ready.promise;
  expect(lines).toEqual([Array.from({ length: 50 }, (_, i) => `10:01:02 Example log ${i}`)]);
  await logs.close();
});
it("an inventory poll failure keeps the last devices and reports the read problem", async () => {
  const time = clock();
  const ready = Promise.withResolvers<void>();
  const inventories: import("./inventory.ts").Inventory[] = [];
  const watch = new InventoryWatch({
    ...time,
    intervalMs: 4000,
    async read() {
      throw new Error("read failed");
    },
  });
  watch.update({
    devices: [{ id: "android:Pixel", name: "Pixel", platform: "android", state: "booted" }],
    issues: [],
  });
  watch.watch((inventory) => {
    inventories.push(inventory);
    ready.resolve();
  });
  watch.poll(true);
  time.advance(4000);
  await ready.promise;
  expect(inventories[0]?.devices[0]?.name).toBe("Pixel");
  expect(inventories[0]?.issues[0]?.hint).toBeTruthy();
  watch.poll(false);
});
