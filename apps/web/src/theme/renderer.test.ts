import { memoryKeyValue } from "@/test/harness.tsx";
import { describe, expect, it } from "vitest";
import { isSoftwareRenderer, softwareRendering } from "./renderer.ts";

describe("a device drawing without graphics acceleration is recognised", () => {
  it("names CPU rasterizers on every platform as software", () => {
    for (const name of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)",
      "Mesa softpipe",
    ])
      expect(isSoftwareRenderer(name)).toBe(true);
  });

  it("names real GPUs as hardware", () => {
    for (const name of [
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)",
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
      "Apple GPU",
    ])
      expect(isSoftwareRenderer(name)).toBe(false);
  });

  it("treats a browser with no WebGL as drawing in software", () => {
    expect(isSoftwareRenderer(undefined)).toBe(true);
  });
});

describe("the answer is kept so a launch never waits on WebGL", () => {
  const swiftshader = "SwiftShader";
  const gpu = "Apple M3";

  it("a first launch reads the renderer at once and keeps the answer", () => {
    const storage = memoryKeyValue();
    const idle: Array<() => void> = [];
    const first = softwareRendering({
      storage,
      renderer: () => swiftshader,
      idle: (task) => idle.push(task),
      automated: false,
    });
    expect(first).toBe(true);
    expect(idle).toHaveLength(0);
    let read = 0;
    const second = softwareRendering({
      storage,
      renderer: () => {
        read++;
        return gpu;
      },
      idle: (task) => idle.push(task),
      automated: false,
    });
    expect(second).toBe(true);
    expect(read).toBe(0);
  });

  it("a later launch checks again when idle, for the launch after", () => {
    const storage = memoryKeyValue();
    const idle: Array<() => void> = [];
    const options = (renderer: string) => ({
      storage,
      renderer: () => renderer,
      idle: (task: () => void) => idle.push(task),
      automated: false,
    });
    softwareRendering(options(swiftshader));
    expect(softwareRendering(options(gpu))).toBe(true);
    for (const task of idle.splice(0)) task();
    expect(softwareRendering(options(gpu))).toBe(false);
  });

  it("an automated browser keeps the chosen design and stores nothing", () => {
    const storage = memoryKeyValue();
    expect(
      softwareRendering({ storage, renderer: () => swiftshader, idle: () => {}, automated: true }),
    ).toBe(false);
    expect(storage.getItem("ace.software-rendering")).toBeNull();
  });
});
