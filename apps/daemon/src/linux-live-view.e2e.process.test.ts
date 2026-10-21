/*
 * Linux live view end to end: a person watching a real desktop app. The real Linux screen
 * helper sends JPEG pictures, the daemon re-encodes them to H.264 with the browser service's
 * encoder-only Chrome (ace's pinned build), and a viewer on the daemon WebSocket receives the
 * video exactly as the web and iOS clients do. ffmpeg decodes what arrived, so the assertions
 * are about pictures, not messages. No provider CLI or model runs.
 * Opt-in only: `apps/daemon/scripts/linux-e2e/run.sh` starts a throwaway desktop and sets
 * `ACE_LINUX_DESKTOP_E2E` (x11 or wayland) and `ACE_SCREEN_HELPER`. Needs ffmpeg.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ScreenInventory, ScreenState, type ScreenTarget } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { LiveViewer, type ViewerFrame } from "./testing/live-viewer.ts";

const session = process.env.ACE_LINUX_DESKTOP_E2E;
const helper = process.env.ACE_SCREEN_HELPER;
const graphical = session === "x11" || session === "wayland";
const enabled = process.platform === "linux" && graphical && !!helper;
const exec = promisify(execFile);
const calculator = "org.gnome.Calculator";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** One decoded picture: its size, whether it was a keyframe, and its RGB pixels. */
type Decoded = { width: number; height: number; key: boolean; pixels: Buffer };

const Probe = z.object({
  frames: z
    .array(z.object({ width: z.number(), height: z.number(), key_frame: z.number() }))
    .default([]),
});

let decodes = 0;

/** The viewer's H.264 as ffmpeg decodes it, frame by frame, in arrival order. */
async function decode(frames: readonly ViewerFrame[]): Promise<Decoded[]> {
  const directory = await mkdtemp(join(tmpdir(), "ace-live-view-"));
  try {
    const stream = join(directory, "view.h264");
    await writeFile(stream, Buffer.concat(frames.map((frame) => frame.bytes)));
    // Kept for a person to look at when a picture assertion fails.
    const artifacts = process.env.ACE_E2E_ARTIFACTS;
    const name = `live-view-${session}-${++decodes}.h264`;
    if (artifacts) await writeFile(join(artifacts, name), await readFile(stream));
    const probe = await exec(
      "ffprobe",
      ["-v", "error", "-f", "h264", "-show_frames", "-of", "json", stream],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const raw = join(directory, "view.rgb");
    const toRgb = ["-f", "rawvideo", "-pix_fmt", "rgb24", "-y", raw];
    await exec("ffmpeg", ["-v", "error", "-f", "h264", "-i", stream, ...toRgb]);
    const pixels = await readFile(raw);
    let offset = 0;
    return Probe.parse(JSON.parse(probe.stdout)).frames.map((frame) => {
      const size = frame.width * frame.height * 3;
      const picture = pixels.subarray(offset, offset + size);
      offset += size;
      return {
        width: frame.width,
        height: frame.height,
        key: frame.key_frame === 1,
        pixels: picture,
      };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The share of pixels that differ by more than a little between two decoded pictures. */
function changed(a: Decoded, b: Decoded): number {
  let differing = 0;
  for (let index = 0; index < a.pixels.length; index += 3) {
    let distance = 0;
    for (let channel = 0; channel < 3; channel++)
      distance += Math.abs((a.pixels[index + channel] ?? 0) - (b.pixels[index + channel] ?? 0));
    if (distance > 72) differing++;
  }
  return differing / (a.pixels.length / 3);
}

function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error(`Nothing at ${index} of ${items.length}`);
  return item;
}

async function world(): Promise<EvalWorld> {
  const created = await evalWorld({ browser: true, ...(helper ? { screenHelper: helper } : {}) });
  cleanups.push(() => created.close());
  return created;
}

const seedPortal = new URL(
  "../../../native/screen-helper-linux/tests/computer/seed_portal.py",
  import.meta.url,
).pathname;

/** A Wayland window target: the portal's chooser, not the id, decides what is shared. */
const waylandCalculator: ScreenTarget = {
  kind: "window",
  bundleId: "gnome-calculator",
  windowId: 1,
};

/**
 * The window a person picks. X11 lists Calculator's window. Wayland lists nothing: the portal's
 * chooser picks the source, so the test records the approval the person would give there
 * (test scaffolding only; ace never writes the permission store) for the helper to restore.
 */
async function calculatorWindow(
  ace: EvalWorld,
  viewer: LiveViewer,
): Promise<{ target: ScreenTarget; size?: { width: number; height: number } }> {
  const inventory = ScreenInventory.parse(await viewer.request({ op: "targets" }));
  if (session === "x11") {
    const window = inventory.windows.find((entry) => entry.title === "Calculator");
    if (!window?.bounds) throw new Error(`No Calculator window: ${JSON.stringify(inventory)}`);
    return {
      target: { kind: "window", bundleId: window.bundleId, windowId: window.windowId },
      size: { width: window.bounds.width, height: window.bounds.height },
    };
  }
  expect(inventory).toEqual({ displays: [], windows: [] });
  const token = join(dirname(ace.daemon.tokenPath), "screen-artifacts", "portal", "restore-token");
  // GNOME's shell names the window's app by its desktop file.
  const app = `${calculator}.desktop`;
  await exec("python3", [seedPortal, "grant-remote-desktop", token, app, "Calculator"]);
  cleanups.push(async () => {
    await exec("python3", [seedPortal, "revoke-remote-desktop", token]).catch(() => {});
  });
  return { target: waylandCalculator };
}

describe.skipIf(!enabled)(`Linux live view (${session ?? "off"})`, () => {
  it("a person watching Calculator gets decodable H.264 of its window that changes when the app does", async () => {
    const ace = await world();
    expect(ace.browser, "ace's pinned Chrome (ACE_CHROMIUM_PATH) encodes the video").toBe(true);
    const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath);
    cleanups.push(() => viewer.close());
    const { target, size } = await calculatorWindow(ace, viewer);
    const state = ScreenState.parse(await viewer.request({ op: "start", target }));
    await viewer.request({ op: "subscribe", sessionId: state.sessionId });
    expect(
      await viewer.request({
        op: "stream.configure",
        sessionId: state.sessionId,
        settings: { codec: "h264", maxWidth: 1920, maxHeight: 1200, fps: 30, bitrate: 4_000_000 },
      }),
    ).toEqual({ codec: "h264" });
    const before = await viewer.frames(state.sessionId, { keyframes: 1, count: 1 });

    // The person sees the agent work: 7 × 6 = goes into the display.
    const { agent } = await ace.agent({ prompt: "multiply in the calculator" });
    const outline = (await agent.call("screen_state", { app: calculator })).text;
    const id = (name: string) => {
      const match = new RegExp(`^\\s*(\\d+) button ${name}(?:,|$)`, "m").exec(outline)?.[1];
      if (!match) throw new Error(`No button ${name} in:\n${outline}`);
      return Number(match);
    };
    const acted = await agent.call("screen_act", {
      app: calculator,
      actions: [
        ...["7", "×", "6", "="].map((key) => ({ type: "click", id: id(key) })),
        { type: "wait_for", text: "42", timeout_ms: 5_000 },
      ],
    });
    expect(acted.failed, acted.text).toBe(false);
    // Each press repaints; a moment after the last one the picture shows 42.
    const after = await viewer.frames(state.sessionId, {
      count: before.length + 1,
      afterMs: 2_000,
    });

    // Only video reached the viewer, and every picture of it decodes.
    expect(after.every((frame) => frame.codec.startsWith("avc1."))).toBe(true);
    const decoded = await decode(after);
    expect(decoded.length).toBe(after.length);
    expect(decoded[0]?.key).toBe(true);
    expect(decoded.some((frame, index) => index > 0 && !frame.key)).toBe(true);
    // Every picture has the size its header gives: the window's, made even as H.264 needs.
    const first = at(decoded, 0);
    const expected = size
      ? { width: Math.floor(size.width / 2) * 2, height: Math.floor(size.height / 2) * 2 }
      : { width: first.width, height: first.height };
    // The window alone, never the 1280×800 desktop the runner makes around it.
    expect(expected.width).toBeGreaterThan(200);
    expect(expected.width).toBeLessThan(800);
    expect(expected.height).toBeGreaterThan(200);
    expect(expected.height).toBeLessThan(800);
    for (const [index, frame] of decoded.entries()) {
      expect({ width: frame.width, height: frame.height }).toEqual(expected);
      expect({ width: after[index]?.width, height: after[index]?.height }).toEqual(expected);
    }
    // The last picture shows the result, which the one before the agent acted didn't.
    expect(changed(at(decoded, before.length - 1), at(decoded, -1))).toBeGreaterThan(0.001);
  }, 120_000);

  it.skipIf(session !== "wayland")(
    "a Wayland live view nobody approves on the desktop fails with the reason and leaves nothing running",
    async () => {
      const ace = await world();
      const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath);
      cleanups.push(() => viewer.close());
      const started = viewer.request({ op: "start", target: waylandCalculator }, 180_000);
      await expect(started).rejects.toThrow(/Portal consent timed out/);
      expect(await viewer.request({ op: "sessions" })).toEqual([]);
    },
    200_000,
  );
});
