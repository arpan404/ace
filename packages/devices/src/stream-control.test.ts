import { expect, it } from "vitest";
import { DeviceStreamControl, commonDeviceStream } from "./index.ts";
import type { ScreenStreamSettings } from "@ace/protocol";
const fast: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 1080,
  maxHeight: 1920,
  fps: 60,
  bitrate: 6000000,
};
const slow: ScreenStreamSettings = {
  codec: "jpeg",
  maxWidth: 360,
  maxHeight: 720,
  fps: 30,
  bitrate: 1000000,
};
it("a slow image viewer sets the shared stream budget and its disconnect restores video", async () => {
  const applied: ScreenStreamSettings[] = [];
  const control = new DeviceStreamControl(async (settings) => {
    applied.push(settings);
    return { codec: settings.codec };
  });
  await control.set("fast", fast);
  await control.set("slow", slow);
  expect(applied.at(-1)).toEqual(slow);
  await control.remove("slow");
  expect(applied.at(-1)).toEqual(fast);
  await control.close();
});
it("rapid panel resizing retains the newest size while a native update is blocked", async () => {
  const applied: ScreenStreamSettings[] = [];
  const blocked = Promise.withResolvers<void>();
  const control = new DeviceStreamControl(async (settings) => {
    applied.push(settings);
    if (applied.length === 1) await blocked.promise;
    return { codec: settings.codec };
  });
  const first = control.set("view", fast);
  for (let i = 0; i < 100; i++) void control.set("view", { ...slow, maxWidth: 400 + i * 2 });
  expect(applied).toEqual([fast]);
  blocked.resolve();
  await first;
  expect(applied).toEqual([fast, { ...slow, maxWidth: 598 }]);
  await control.close();
});
it("the shared capture fits every viewer instead of letting the latest subscriber increase traffic", () => {
  const mixed = commonDeviceStream([
    fast,
    { ...fast, maxWidth: 800, maxHeight: 1200, fps: 30, bitrate: 2000000 },
  ]);
  expect(mixed).toEqual({ ...fast, maxWidth: 800, maxHeight: 1200, fps: 30, bitrate: 2000000 });
});

it("concurrent screenshots keep JPEG until the last image consumer releases, then restore video", async () => {
  const applied: ScreenStreamSettings[] = [];
  const control = new DeviceStreamControl(async (settings) => {
    applied.push(settings);
    return { codec: settings.codec };
  });
  await control.set("view", fast);
  const first = control.acquireImage();
  const second = control.acquireImage();
  await Promise.all([first.ready, second.ready]);
  expect(applied.at(-1)?.codec).toBe("jpeg");
  await first.release();
  expect(applied.at(-1)?.codec).toBe("jpeg");
  await second.release();
  expect(applied.at(-1)).toEqual(fast);
  await control.close();
});
