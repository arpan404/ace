import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { findExecutable } from "@ace/provider-kit/discovery";
import type { Frame } from "@ace/screen";
import type { ScreenUINode } from "@ace/protocol";
import { simulatorCapture } from "./simulator-capture.ts";
import type { DeviceRuntime } from "./runtime.ts";

const execute = promisify(execFile);
const udid =
  process.env["ACE_DEVICE_LIVE"] === "1" ? process.env["ACE_DEVICE_LIVE_IOS_UUID"] : undefined;
/**
 * Opt-in: drives a real serve-sim against a booted Simulator set aside for the purpose
 * (ACE_DEVICE_LIVE=1, ACE_DEVICE_LIVE_IOS_UUID). It opens Settings there and taps inside it.
 */
it.skipIf(!udid)(
  "a real Simulator streams H.264 untouched, and a tree ref taps the element it names",
  { timeout: 120000 },
  async () => {
    if (!udid) return;
    const command = await findExecutable("serve-sim", process.env);
    if (!command) throw new Error("Opt-in live check requires serve-sim on PATH");
    await execute("xcrun", ["simctl", "launch", udid, "com.apple.Preferences"]);
    const runtime: DeviceRuntime = {
      now: () => performance.now(),
      id: () => "live",
      spawn: spawnRawSupervised,
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    };
    const frames: Frame[] = [];
    const failures: unknown[] = [];
    const capture = await simulatorCapture({
      command,
      device: { id: `ios:${udid}`, name: "live", platform: "ios", state: "booted" },
      streamId: "live",
      fps: 60,
      env: process.env,
      runtime,
      publish: (frame) => frames.push(frame),
      failure: (error) => failures.push(error),
    });
    onTestFinished(() => capture.stop());
    const settings = { codec: "h264", maxWidth: 3840, maxHeight: 3840, fps: 60, bitrate: 12e6 };
    expect(await capture.configure?.({ ...settings, codec: "h264" })).toEqual({ codec: "h264" });
    const key = frames.find((frame) => frame.header.codec === "h264");
    if (!key) throw new Error("No H.264 frame");
    expect(key.header).toMatchObject({ codec: "h264", keyframe: true, scale: 1 });
    expect(key.header.version === 1 && key.header.videoCodec).toMatch(/^avc1\.64/);
    // Annex B with in-band parameter sets: SPS (7), PPS (8), then the IDR slice (5).
    expect(nalTypes(key.payload).slice(0, 3)).toEqual([7, 8, 5]);

    // Settings may still be animating in; act on a ref two consecutive reads agree on.
    let general: ScreenUINode | undefined;
    await expect
      .poll(
        async () => {
          const tree = await capture.ui?.tree({ maxNodes: 512, maxDepth: 16 });
          const next = flatten(tree?.nodes ?? []).find(
            (node) => node.name === "General" && node.actions.includes("press"),
          );
          const settled = next !== undefined && next.ref === general?.ref;
          general = next;
          return settled;
        },
        { timeout: 15000, interval: 500 },
      )
      .toBe(true);
    if (!general) throw new Error("No General row");
    expect(general.ref).toMatch(/^i_[0-9a-f]{40}$/);
    await capture.ui?.act({ ref: general.ref, action: "press" }, () => {});
    await expect
      .poll(
        async () => {
          const next = await capture.ui?.find({ query: { name: "About" } });
          return next?.nodes.length ?? 0;
        },
        { timeout: 10000, interval: 300 },
      )
      .toBeGreaterThan(0);
    // The old ref named a row on the previous screen; it no longer resolves.
    await expect(capture.ui?.act({ ref: general.ref, action: "press" }, () => {})).rejects.toThrow(
      "stale",
    );
    // After the switch to H.264 no JPEG frame is published: serve-sim's MJPEG stream is closed.
    expect(frames.slice(frames.indexOf(key)).every((frame) => frame.header.codec === "h264")).toBe(
      true,
    );
    expect(failures).toEqual([]);
  },
);

function nalTypes(annexB: Buffer): number[] {
  const types: number[] = [];
  for (let at = annexB.indexOf(startCode); at >= 0; at = annexB.indexOf(startCode, at + 4))
    types.push((annexB[at + 4] ?? 0) & 31);
  return types;
}
const startCode = Buffer.from([0, 0, 0, 1]);

function flatten(nodes: ScreenUINode[]): ScreenUINode[] {
  const all: ScreenUINode[] = [];
  const pending = [...nodes];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    all.push(node);
    pending.push(...node.children);
  }
  return all;
}
