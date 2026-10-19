import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture } from "./index.ts";

// Opt-in: a booted emulator the owner names, e.g. ACE_DEVICE_LIVE_ANDROID_SERIAL=emulator-5554.
// It downloads the pinned scrcpy server and types into whatever field has focus: open a text
// field on a disposable AVD first.
const serial =
  process.env["ACE_DEVICE_LIVE"] === "1" && process.env["ACE_DEVICE_LIVE_ANDROID_SERIAL"];

async function live() {
  const tools = await mkdtemp(join(tmpdir(), "ace-scrcpy-live-"));
  onTestFinished(() => rm(tools, { recursive: true, force: true }));
  const platform = new DevicePlatform({
    platform: process.platform,
    home: process.env["ACE_TEST_REAL_HOME"] ?? homedir(),
    env: process.env,
    toolsDirectory: tools,
  });
  onTestFinished(() => platform.close());
  const device = (await platform.list()).find((entry) => entry.serial === serial);
  if (!device) throw new Error("The named emulator is not booted");
  return { platform, device };
}

it.skipIf(!serial)(
  "the real emulator streams H.264 without ffmpeg, takes two fingers and Unicode text",
  async () => {
    const { platform, device } = await live();
    const frames: Frame[] = [];
    const failures: unknown[] = [];
    const capture = await startCapture({
      device,
      streamId: "live",
      fps: 60,
      platform,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      runtime: {
        now: Date.now,
        id: () => crypto.randomUUID(),
        after(ms, run) {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
        spawn: spawnRawSupervised,
      },
      publish: (frame) => frames.push(frame),
      failure: (error) => failures.push(error),
    });
    onTestFinished(() => capture.stop());
    expect(capture.multiTouch).toBe(true);
    for (let wait = 0; wait < 100 && !frames.length; wait++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames[0]?.header).toMatchObject({ codec: "h264", keyframe: true });
    const [width, height] = [frames[0]?.header.width ?? 0, frames[0]?.header.height ?? 0];
    const centre = { x: Math.floor(width / 2 / (frames[0]?.header.scale ?? 1)), y: 0 };
    centre.y = Math.floor(height / 2 / (frames[0]?.header.scale ?? 1));
    for (const [pointerId, offset] of [
      [0, -100],
      [1, 100],
    ] as const)
      await capture.input?.(
        { kind: "pointer", phase: "down", x: centre.x, y: centre.y + offset, pointerId },
        () => {},
      );
    await capture.releaseInput?.();
    await capture.input?.({ kind: "type", text: "héllo 👋" }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    const texts: string[] = [];
    const visit = (node: { value?: string; children: unknown[] }) => {
      if (node.value) texts.push(node.value);
      for (const child of node.children) visit(child as typeof node);
    };
    for (const node of (await platform.uiTree(device, { maxNodes: 512, maxDepth: 16 })).nodes)
      visit(node);
    expect(texts.some((text) => text.includes("héllo 👋"))).toBe(true);
    expect(failures).toEqual([]);
  },
  60_000,
);

it.skipIf(!serial)(
  "the real emulator answers UI tree reads in under 300 ms",
  async () => {
    const { platform, device } = await live();
    await platform.uiTree(device, {});
    const started = performance.now();
    const tree = await platform.uiTree(device, {});
    expect(performance.now() - started).toBeLessThan(300);
    expect(tree.nodes.length).toBeGreaterThan(0);
  },
  60_000,
);
