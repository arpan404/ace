import { expect, it } from "vitest";
import { probeChromeGpu, softwareCompositing } from "./gpu-scale.ts";
import { executablePath, fixture } from "./test-support.ts";

it.runIf(process.platform === "win32" && executablePath)(
  "Windows: ace's Chrome draws at device scale 1 where it has no GPU and 2 where it has one",
  async () => {
    const info = await probeChromeGpu(executablePath ?? "");
    expect(info).toBeDefined();
    const f = await fixture();
    await f.navigate();
    expect(await f.evaluate("devicePixelRatio")).toBe(softwareCompositing(info) ? 1 : 2);
  },
  90_000,
);

it.runIf(process.platform === "win32" && executablePath)(
  "Windows: an embedder's chosen device scale is kept whatever the GPU",
  async () => {
    const f = await fixture({ chrome: { deviceScaleFactor: 2 } });
    await f.navigate();
    expect(await f.evaluate("devicePixelRatio")).toBe(2);
  },
  90_000,
);
