import { expect, test } from "vitest";
import { softwareCompositing, windowsDeviceScale } from "./gpu-scale.ts";

/** Chrome's `SystemInfo.getInfo` on GitHub's Windows ARM64 runner: no GPU driver at all. */
const basicRender = {
  gpu: {
    devices: [{ vendorId: 0x1414, deviceId: 0x8c, deviceString: "Microsoft Basic Render Driver" }],
    featureStatus: { gpu_compositing: "disabled_software", rasterization: "disabled_software" },
  },
};
const adreno = {
  gpu: {
    devices: [{ vendorId: 0x4d4f4351, deviceId: 0x36334330, deviceString: "Qualcomm Adreno" }],
    featureStatus: { gpu_compositing: "enabled", rasterization: "enabled" },
  },
};

test("a Windows Chrome that composites in software draws at device scale 1", () => {
  expect(windowsDeviceScale(basicRender, 2)).toBe(1);
});

test("a Windows Chrome on a real GPU keeps the preferred device scale", () => {
  expect(windowsDeviceScale(adreno, 2)).toBe(2);
});

test("only Microsoft's software rasterizer counts as no GPU when compositing reports nothing", () => {
  const warpOnly = { gpu: { devices: [{ vendorId: 0x1414, deviceId: 0x8c }] } };
  const mixed = {
    gpu: {
      devices: [
        { vendorId: 0x1414, deviceId: 0x8c },
        { vendorId: 0x10de, deviceId: 1 },
      ],
    },
  };
  expect(softwareCompositing(warpOnly)).toBe(true);
  expect(softwareCompositing(mixed)).toBe(false);
});

test("a GPU report that is missing or unreadable keeps the preferred scale", () => {
  expect(windowsDeviceScale(undefined, 2)).toBe(2);
  expect(windowsDeviceScale({ gpu: "busy" }, 2)).toBe(2);
});
