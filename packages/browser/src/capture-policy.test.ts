import { describe, expect, it } from "vitest";
import { captureSettings, CapturePressure, type CaptureViewer } from "./capture-policy.ts";

const phone: CaptureViewer = {
  viewport: { width: 390, height: 800, devicePixelRatio: 3 },
  local: false,
};
const laptop: CaptureViewer = {
  viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
  local: true,
};

describe("capture size follows what each viewer's screen shows", () => {
  it("a DPR 3 phone over the relay gets three device pixels per CSS pixel", () => {
    expect(captureSettings(0, [phone])).toMatchObject({ maxWidth: 1170, maxHeight: 2400 });
  });

  it("a DPR 1 remote viewer isn't sent more pixels than it shows", () => {
    const settings = captureSettings(0, [
      { viewport: { width: 1000, height: 600, devicePixelRatio: 1 }, local: false },
    ]);
    expect(settings).toMatchObject({ maxWidth: 1000, maxHeight: 600 });
  });

  it("the shared capture fits the most demanding viewer, within the largest frame", () => {
    const wide: CaptureViewer = {
      viewport: { width: 2000, height: 1200, devicePixelRatio: 3 },
      local: false,
    };
    expect(captureSettings(0, [phone, laptop])).toMatchObject({
      maxWidth: 2560,
      maxHeight: 2400,
    });
    const settings = captureSettings(0, [wide]);
    expect(Math.max(settings.maxWidth, settings.maxHeight)).toBe(2560);
  });
});

describe("a backlog costs frames before it costs quality", () => {
  it("a short backlog lowers the frame rate and keeps the picture's quality", () => {
    const calm = captureSettings(0, [phone]);
    const backlog = captureSettings(1, [phone]);
    expect(backlog.fps).toBeLessThan(calm.fps);
    expect(backlog.quality).toBe(calm.quality);
    expect(backlog.maxWidth).toBe(calm.maxWidth);
  });

  it("a lasting backlog lowers quality only as far as text stays readable", () => {
    const lasting = captureSettings(2, [phone]);
    expect(lasting.quality).toBeLessThan(captureSettings(0, [phone]).quality);
    expect(lasting.quality).toBeGreaterThanOrEqual(60);
  });

  it("a decode wait under half a second changes nothing", () => {
    const pressure = new CapturePressure();
    expect(pressure.sample(true, 0)).toBe(0);
    expect(pressure.sample(true, 400)).toBe(0);
    expect(pressure.sample(false, 450)).toBe(0);
    expect(pressure.sample(true, 500)).toBe(0);
  });

  it("only a backlog that lasts seconds reaches the quality step", () => {
    const pressure = new CapturePressure();
    pressure.sample(true, 0);
    expect(pressure.sample(true, 600)).toBe(1);
    expect(pressure.sample(true, 2900)).toBe(1);
    expect(pressure.sample(true, 3000)).toBe(2);
  });

  it("once the backlog clears, quality comes back within a second and the rate soon after", () => {
    const pressure = new CapturePressure();
    pressure.sample(true, 0);
    pressure.sample(true, 3000);
    expect(pressure.sample(false, 3100)).toBe(2);
    expect(pressure.sample(false, 4100)).toBe(1);
    expect(pressure.sample(false, 5100)).toBe(0);
  });
});
