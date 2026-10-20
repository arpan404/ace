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
  codec: "h264",
  maxWidth: 360,
  maxHeight: 720,
  fps: 60,
  bitrate: 1000000,
};
it("a slow viewer sets the shared stream budget and its disconnect restores the faster one", async () => {
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
it("a resize following an unchanged update applies before either acknowledgement completes", async () => {
  let native = fast;
  const control = new DeviceStreamControl(async (settings) => {
    native = settings;
    return { codec: settings.codec };
  });
  await control.set("view", fast);
  const unchanged = control.set("view", { ...fast });
  const resized = control.set("view", slow);
  await Promise.all([unchanged, resized]);
  expect(native).toEqual(slow);
  await control.close();
});
it("a recording leaves a watched capture on the viewers' video", async () => {
  let native = fast;
  const control = new DeviceStreamControl(async (settings) => {
    native = settings;
    return { codec: settings.codec };
  });
  await control.set("view", fast);
  const recording = control.acquireRecording();
  await recording.ready;
  expect(native).toEqual(fast);
  await recording.release();
  expect(native).toEqual(fast);
  await control.close();
});
it("a recording nobody watches gets its JPEG image budget, and loses it when a viewer arrives", async () => {
  let native: ScreenStreamSettings | undefined;
  const control = new DeviceStreamControl(async (settings) => {
    native = settings;
    return { codec: settings.codec };
  });
  const recording = control.acquireRecording();
  await recording.ready;
  expect(native).toMatchObject({ codec: "jpeg", maxWidth: 1280, maxHeight: 720, fps: 15 });
  await control.set("view", fast);
  expect(native).toEqual(fast);
  await control.remove("view");
  expect(native).toMatchObject({ codec: "jpeg", maxHeight: 720, fps: 15 });
  await recording.release();
  await control.close();
});
it("a live view never accepts JPEG, and a capture that can't stream video is refused", async () => {
  const control = new DeviceStreamControl(async () => ({ codec: "jpeg" }));
  await expect(control.set("old", { ...fast, codec: "jpeg" })).rejects.toMatchObject({
    code: "not_supported",
  });
  await expect(control.set("view", fast)).rejects.toMatchObject({ code: "not_supported" });
  await control.close();
});
it("after a refused video request the capture gets the remaining settings again", async () => {
  const applied: ScreenStreamSettings[] = [];
  const control = new DeviceStreamControl(async (settings) => {
    applied.push(settings);
    return { codec: "jpeg" };
  });
  await control.refresh();
  await expect(control.set("view", fast)).rejects.toMatchObject({ code: "not_supported" });
  await control.remove("view");
  expect(applied.map((settings) => settings.codec)).toEqual(["jpeg", "h264", "jpeg"]);
  expect(applied.at(-1)).toEqual(applied[0]);
  await control.close();
});
it("the shared capture fits every viewer instead of letting the latest subscriber increase traffic", () => {
  const mixed = commonDeviceStream([
    fast,
    { ...fast, maxWidth: 800, maxHeight: 1200, bitrate: 2000000 },
  ]);
  expect(mixed).toEqual({ ...fast, maxWidth: 800, maxHeight: 1200, bitrate: 2000000 });
});
