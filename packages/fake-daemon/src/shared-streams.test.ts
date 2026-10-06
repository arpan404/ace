import { DeviceClient } from "@ace/client/devices";
import { ScreenStreamClient, type PortableFrame } from "@ace/client/screen-stream";
import { expect, it, onTestFinished } from "vitest";
import { FakeDaemon } from "./index.ts";

/** Let the fake answer: its replies and frames arrive a few microtasks after a request. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One live view as the web app mounts it: its frames, and its hold on the stream. */
function view(
  client: Pick<ScreenStreamClient, "watchFrames" | "retainStream">,
  target: string,
): { frames: PortableFrame[]; close(): void } {
  const frames: PortableFrame[] = [];
  const unwatch = client.watchFrames(target, async (frame) => void frames.push(frame));
  const release = client.retainStream(target);
  return {
    frames,
    close: () => {
      unwatch();
      release();
    },
  };
}

it("two views of one app share its stream: closing one leaves the other live, closing both ends it", async () => {
  let id = 0;
  const daemon = new FakeDaemon({
    clock: () => 1000,
    screenId: () => `screen-${++id}`,
    screenSchedule: () => () => {},
  });
  const stream = new ScreenStreamClient({ id: () => `request-${++id}`, schedule: () => () => {} });
  onTestFinished(() => stream.disconnect());
  stream.connect(daemon.screen.transport());
  await settle();
  await stream.request({ op: "enable", enabled: true });
  await stream.request({ op: "approve", bundleId: "com.apple.TextEdit", allowed: true });
  const started = (await stream.request({
    op: "start",
    target: { kind: "app", bundleId: "com.apple.TextEdit" },
    fps: 10,
  })) as { sessionId: string };
  const sessionId = started.sessionId;
  await stream.request({ op: "controller", sessionId, controller: "human" });
  const paint = async () => {
    await stream.request({ op: "input", sessionId, input: { kind: "pointer.move", x: 1, y: 1 } });
    await settle();
  };

  const panel = view(stream, sessionId);
  const settings = view(stream, sessionId);
  await settle();
  panel.close();
  const before = settings.frames.length;
  await paint();
  expect(settings.frames.length).toBe(before + 1);

  settings.close();
  // Nothing holds the stream now: a view that only watches frames gets none.
  const watcher: PortableFrame[] = [];
  onTestFinished(stream.watchFrames(sessionId, async (frame) => void watcher.push(frame)));
  await paint();
  expect(watcher).toEqual([]);
});

it("two views of one device share its stream: closing one leaves the other live, closing both ends it", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let id = 0;
  const devices = new DeviceClient({ id: () => `device-${++id}`, schedule: () => () => {} });
  onTestFinished(() => devices.disconnect());
  devices.connect(daemon.appDevices.transport());
  await settle();
  const deviceId = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";
  await devices.request({ op: "enable", enabled: true });
  await devices.request({ op: "start", deviceId, fps: 10 });
  const paint = async () => {
    await devices.request({ op: "stream.keyframe", deviceId });
    await settle();
  };

  const first = view(devices, deviceId);
  const second = view(devices, deviceId);
  await settle();
  first.close();
  const before = second.frames.length;
  await paint();
  expect(second.frames.length).toBe(before + 1);

  second.close();
  const watcher: PortableFrame[] = [];
  onTestFinished(devices.watchFrames(deviceId, async (frame) => void watcher.push(frame)));
  await paint();
  expect(watcher).toEqual([]);
});
