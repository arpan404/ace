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
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenInventory, ScreenState } from "@ace/protocol";
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

/** One decoded picture: its size, whether it was a keyframe, and its grey pixels. */
type Decoded = { width: number; height: number; key: boolean; pixels: Buffer };

/** The viewer's H.264 as ffmpeg decodes it, frame by frame, in arrival order. */
async function decode(frames: readonly ViewerFrame[]): Promise<Decoded[]> {
  const directory = await mkdtemp(join(tmpdir(), "ace-live-view-"));
  try {
    const stream = join(directory, "view.h264");
    await writeFile(stream, Buffer.concat(frames.map((frame) => frame.bytes)));
    const probe = await exec(
      "ffprobe",
      ["-v", "error", "-f", "h264", "-show_frames", "-of", "json", stream],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const described = JSON.parse(probe.stdout) as {
      frames?: { width: number; height: number; key_frame: number }[];
    };
    const raw = join(directory, "view.gray");
    await exec(
      "ffmpeg",
      ["-v", "error", "-f", "h264", "-i", stream, "-f", "rawvideo"].concat([
        "-pix_fmt",
        "gray",
        "-y",
        raw,
      ]),
    );
    const pixels = await readFile(raw);
    let at = 0;
    return (described.frames ?? []).map((frame) => {
      const size = frame.width * frame.height;
      const picture = pixels.subarray(at, at + size);
      at += size;
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
  for (let index = 0; index < a.pixels.length; index++)
    if (Math.abs((a.pixels[index] ?? 0) - (b.pixels[index] ?? 0)) > 24) differing++;
  return differing / a.pixels.length;
}

async function world(): Promise<EvalWorld> {
  const created = await evalWorld({ browser: true, ...(helper ? { screenHelper: helper } : {}) });
  cleanups.push(() => created.close());
  return created;
}

describe.skipIf(!enabled)(`Linux live view (${session ?? "off"})`, () => {
  it("a person watching Calculator gets decodable H.264 of its window that changes when the app does", async () => {
    const ace = await world();
    expect(ace.browser, "ace's pinned Chrome (ACE_CHROMIUM_PATH) encodes the video").toBe(true);
    const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath);
    cleanups.push(() => viewer.close());
    const inventory = ScreenInventory.parse(await viewer.request({ op: "targets" }));
    const window = inventory.windows.find((entry) => entry.title === "Calculator");
    if (!window?.bounds) throw new Error(`No Calculator window: ${JSON.stringify(inventory)}`);
    const state = ScreenState.parse(
      await viewer.request({
        op: "start",
        target: { kind: "window", bundleId: window.bundleId, windowId: window.windowId },
      }),
    );
    await viewer.request({ op: "subscribe", sessionId: state.sessionId });
    expect(
      await viewer.request({
        op: "stream.configure",
        sessionId: state.sessionId,
        settings: { codec: "h264", maxWidth: 1920, maxHeight: 1200, fps: 30, bitrate: 4_000_000 },
      }),
    ).toEqual({ codec: "h264" });
    const before = await viewer.frames(state.sessionId, { keyframes: 1, count: 3 });

    // The person sees the agent work: 7 × 6 = goes into the display.
    const { agent } = await ace.agent({ prompt: "multiply in the calculator" });
    const outline = (await agent.call("screen_state", { app: calculator })).text;
    const id = (name: string) => {
      const match = new RegExp(
        `^\\s*(\\d+) button ${name.replace(/[*+]/g, "\\$&")}(?:,|$)`,
        "m",
      ).exec(outline)?.[1];
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
    const after = await viewer.frames(state.sessionId, { count: before.length + 3 });

    // Only video reached the viewer, and every picture of it decodes.
    expect(after.every((frame) => frame.codec.startsWith("avc1."))).toBe(true);
    const decoded = await decode(after);
    expect(decoded.length).toBe(after.length);
    expect(decoded[0]?.key).toBe(true);
    expect(decoded.some((frame, index) => index > 0 && !frame.key)).toBe(true);
    // The pictures are the window's size (even, as H.264 needs) and the header says so.
    const width = Math.floor(window.bounds.width / 2) * 2;
    const height = Math.floor(window.bounds.height / 2) * 2;
    for (const [index, frame] of decoded.entries()) {
      expect({ width: frame.width, height: frame.height }).toEqual({ width, height });
      expect({ width: after[index]?.width, height: after[index]?.height }).toEqual({
        width,
        height,
      });
    }
    const first = decoded[0];
    const last = decoded.at(-1);
    if (!first || !last) throw new Error("No pictures decoded");
    expect(changed(first, last)).toBeGreaterThan(0.001);
  }, 120_000);
});
