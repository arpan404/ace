// SPDX-License-Identifier: Apache-2.0

/**
 * The native chrome shell (D3.4): the step reads, the look cache, the corner scan and the
 * failures it swallows. `ace-devices` is mocked; no SDK command and no image runs.
 */
import { expect, test, vi } from "vitest";
import type { ImageWork } from "@ace/media/images";
import type { AppDevice as Device } from "@ace/protocol/devices";

const addon = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown[] }[],
  /** One answer queue per export: the last answer repeats. */
  answers: {} as Record<string, string[]>,
}));

/** One addon export: it records its arguments and answers its queue's next value. */
function answer(name: string) {
  return (...args: unknown[]) => {
    addon.calls.push({ name, args });
    const queue = addon.answers[name] ?? ["null"];
    return queue.length > 1 ? queue.shift() : queue[0];
  };
}

vi.mock("./native-devices-addon.ts", () => {
  class Refused extends Error {}
  return {
    Refused,
    nativeDevices: () =>
      new Proxy(
        {},
        {
          get: (_target, name: string) => answer(String(name)),
        },
      ),
  };
});

const { NativeChromeReader, cornerScan } = await import("./native-chrome.ts");

const PIXEL: Device = {
  id: "android:Pixel_7",
  platform: "android",
  name: "Pixel 7",
  state: "booted",
};

const IPHONE: Device = {
  id: "ios:11111111-1111-4111-8111-111111111111",
  platform: "ios",
  name: "iPhone 18 Pro",
  state: "booted",
  model: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
};

const CHROME = JSON.stringify({
  body: { width: 1132, height: 2452, image: "data:image/png;base64,AA==" },
  screen: { x: 26, y: 26, width: 1080, height: 2400 },
  buttons: [],
});

/** What an alpha job answers for a picture of `width` x `height` x `bytes`. */
function alphaResult(bytes: Uint8Array, width: number, height: number) {
  return {
    bytes,
    width,
    height,
    format: "alpha" as const,
    source: { format: "png" as const, width, height, orientation: 0 },
  };
}

/** An image process that measures a small, fully opaque picture. */
const images: ImageWork = {
  run: async () => alphaResult(new Uint8Array([255, 255, 255, 255]), 2, 2),
};

function options(overrides: Record<string, unknown> = {}) {
  return {
    home: "/home/a",
    env: {},
    darwin: true,
    images,
    readFile: async (path: string) =>
      path.endsWith("back.png") ? new Uint8Array([1, 2, 3]) : new Uint8Array(),
    simctl: async () => "{}",
    plutil: async () => "",
    simulatorType: async () => undefined,
    sdkRoots: () => [],
    ...overrides,
  };
}

/** The ladder of answers an emulator skin's read takes. */
function skinAnswers() {
  addon.calls.length = 0;
  addon.answers = {
    devicePlatformImageLimits: ['{"shotDeadlineMs":10000,"lookDeadlineMs":15000,"cacheCap":64}'],
    devicePlatformChromeRoots: ['{"avdRoots":["/avd"],"chromeRoots":[]}'],
    devicePlatformChromeKey: ["android:Pixel_7"],
    devicePlatformAvdConfig: [
      '{"read":["/avd/Pixel_7.ini","/avd/Pixel_7.avd/config.ini"]}',
      '{"read":[],"text":"skin.name=pixel_7\\n"}',
    ],
    devicePlatformSkinDirectories: ['["/sdk/skins/pixel_7"]'],
    devicePlatformSkinLayout: [
      '{"read":["/sdk/skins/pixel_7/layout"]}',
      '{"read":[],"directory":"/sdk/skins/pixel_7","text":"layouts {}"}',
    ],
    devicePlatformSkinOpening: [
      JSON.stringify({
        plan: {
          width: 1080,
          height: 2400,
          x: 59,
          y: 58,
          background: "back.png",
          short: 1080,
          reach: 158,
          backCorner: [59, 58],
        },
        images: [{ key: "back", file: "back.png", corner: [0, 0], reach: 158 }],
      }),
    ],
    devicePlatformSkinImage: ["data:image/png;base64,AQID"],
    devicePlatformSkinChrome: [CHROME],
  };
}

test("an emulator's look is read step by step, with the files it names", async () => {
  skinAnswers();
  const reader = new NativeChromeReader(options());

  const chrome = await reader.chrome(PIXEL);

  expect(chrome?.screen).toEqual({ x: 26, y: 26, width: 1080, height: 2400 });
  // Each read asked for the files it had not seen, then answered once it had them.
  const config = addon.calls.filter((call) => call.name === "devicePlatformAvdConfig");
  expect(config).toHaveLength(2);
  expect(JSON.parse(String(config[0]?.args[2]))).toEqual({});
  // A file the shell could not open is empty text, not a file it has yet to read.
  expect(JSON.parse(String(config[1]?.args[2]))).toEqual({
    "/avd/Pixel_7.ini": "",
    "/avd/Pixel_7.avd/config.ini": "",
  });
});

test("a look is read once and remembered per kind of hardware", async () => {
  skinAnswers();
  const reader = new NativeChromeReader(options());

  await reader.chrome(PIXEL);
  await reader.chrome(PIXEL);

  expect(addon.calls.filter((call) => call.name === "devicePlatformAvdConfig")).toHaveLength(2);
  expect(addon.calls.filter((call) => call.name === "devicePlatformSkinChrome")).toHaveLength(1);
});

test("a simctl that fails leaves no look, rather than throwing", async () => {
  addon.calls.length = 0;
  addon.answers = {
    devicePlatformImageLimits: ['{"shotDeadlineMs":10000,"lookDeadlineMs":15000,"cacheCap":64}'],
    devicePlatformChromeRoots: ['{"avdRoots":[],"chromeRoots":["/Chrome"]}'],
    devicePlatformChromeKey: ["ios:kind:closed"],
  };
  const simctl = vi.fn(async () => {
    throw new Error("simctl is not installed");
  });
  const reader = new NativeChromeReader(options({ simctl }));

  await expect(reader.chrome(IPHONE)).resolves.toBeUndefined();
  // The failed read is remembered, as the TypeScript remembers what it found.
  await expect(reader.chrome(IPHONE)).resolves.toBeUndefined();
  expect(simctl).toHaveBeenCalledTimes(1);
});

test("a corner scan stops at the first pixel outside the picture, and is bounded", async () => {
  const pixels: ImageWork = {
    run: async () => alphaResult(new Uint8Array([10, 20, 30, 40]), 2, 2),
  };

  // Two pixels lie on the diagonal; the third step is outside, so the scan ends there.
  await expect(cornerScan(pixels, new Uint8Array(), [0, 0], 1_000_000, 15_000)).resolves.toEqual([
    10, 40,
  ]);
  // No corner names no pixel at all.
  await expect(cornerScan(pixels, new Uint8Array(), null, 1_000_000, 15_000)).resolves.toEqual([]);

  const large: ImageWork = {
    run: async () => alphaResult(new Uint8Array(100 * 100), 100, 100),
  };
  const started = Date.now();
  const scan = await cornerScan(large, new Uint8Array(), [0, 0], 1e12, 15_000);
  expect(scan).toHaveLength(100);
  expect(Date.now() - started).toBeLessThan(1_000);
});
