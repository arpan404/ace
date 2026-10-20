import { expect, it } from "vitest";
import { deviceStreamProfile } from "./stream-profile.ts";

const phone = { width: 1290, height: 2796 };

it("every connection asks for 60 fps H.264, under any pressure", () => {
  for (const connection of ["local", "remote", "relay"] as const)
    for (const pressure of [0, 1, 2, 3])
      expect(deviceStreamProfile(phone, connection, pressure)).toMatchObject({
        codec: "h264",
        fps: 60,
      });
});

it("pressure lowers the bit rate step by step and never below a 60 fps floor", () => {
  for (const connection of ["local", "remote", "relay"] as const) {
    const rates = [0, 1, 2, 3].map(
      (pressure) => deviceStreamProfile(phone, connection, pressure).bitrate,
    );
    for (let index = 1; index < rates.length; index++)
      expect(rates[index]).toBeLessThan(rates[index - 1] ?? 0);
    expect(rates[3]).toBeGreaterThanOrEqual(1_000_000);
  }
  expect(deviceStreamProfile(phone, "remote").bitrate).toBe(8_000_000);
  expect(deviceStreamProfile(phone, "relay").bitrate).toBe(5_000_000);
});

it("a phone viewing remotely keeps its full screen size until pressure is at its worst", () => {
  const panel = { width: 1170, height: 2532 };
  const calm = deviceStreamProfile(panel, "remote");
  expect(calm).toMatchObject({ maxWidth: 1216, maxHeight: 2560 });
  expect(deviceStreamProfile(panel, "remote", 2)).toMatchObject({
    maxWidth: calm.maxWidth,
    maxHeight: calm.maxHeight,
  });
  const worst = deviceStreamProfile(panel, "remote", 3);
  expect(worst.maxWidth).toBeLessThan(calm.maxWidth);
  expect(worst.maxHeight).toBeLessThan(calm.maxHeight);
});

it("the relay fits a phone screen in a smaller box than a direct remote view", () => {
  const relay = deviceStreamProfile(phone, "relay");
  const remote = deviceStreamProfile(phone, "remote");
  expect(relay.maxWidth).toBeLessThan(remote.maxWidth);
  expect(relay.maxHeight).toBeLessThan(remote.maxHeight);
  expect(relay.maxHeight).toBeGreaterThanOrEqual(2048);
});

it("local pressure keeps the viewer's pixel density", () => {
  const panel = { width: 1051, height: 1951 };
  expect(deviceStreamProfile(panel, "local", 3)).toMatchObject({
    maxWidth: 1088,
    maxHeight: 1984,
    fps: 60,
  });
});

it("a portrait viewer at DPR three keeps its full physical height", () => {
  expect(deviceStreamProfile({ width: 1440, height: 3300 }, "local")).toMatchObject({
    codec: "h264",
    maxWidth: 1472,
    maxHeight: 3328,
    fps: 60,
  });
});

it("small panel resizes keep the same capture budget until the next size bucket", () => {
  expect(deviceStreamProfile({ width: 390, height: 844 }, "local")).toEqual(
    deviceStreamProfile({ width: 400, height: 850 }, "local"),
  );
});
