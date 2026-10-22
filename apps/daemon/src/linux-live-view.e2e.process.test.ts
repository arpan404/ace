/*
 * Linux live view end to end: a person watching a real desktop app. The real Linux screen
 * helper sends JPEG pictures, the daemon re-encodes them to H.264 with the browser service's
 * encoder-only Chrome (ace's pinned build), and a viewer on the daemon WebSocket receives the
 * video exactly as the web and iOS clients do. ffmpeg decodes what arrived, so the assertions
 * are about pictures, not messages. No provider CLI or model runs.
 * Opt-in only: `apps/daemon/scripts/linux-e2e/run.sh` starts a throwaway desktop and sets
 * `ACE_LINUX_DESKTOP_E2E` (x11 or wayland) and `ACE_SCREEN_HELPER`. Needs ffmpeg.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ScreenState } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { at, changed, decodeH264 } from "./testing/decode-h264.ts";
import { shareWindow } from "./testing/linux-share.ts";
import { LiveViewer, type ViewerFrame } from "./testing/live-viewer.ts";

const session = process.env.ACE_LINUX_DESKTOP_E2E;
const helper = process.env.ACE_SCREEN_HELPER;
const graphical = session === "x11" || session === "wayland";
const enabled = process.platform === "linux" && graphical && !!helper;
const calculator = "org.gnome.Calculator";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** The viewer's H.264, decoded; kept in ACE_E2E_ARTIFACTS for a person to look at. */
function decode(frames: readonly ViewerFrame[]) {
  const directory = process.env.ACE_E2E_ARTIFACTS;
  return decodeH264(
    frames.map((frame) => frame.bytes),
    directory ? { directory, name: `live-view-${session}` } : undefined,
  );
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
    const { target, size } = await shareWindow(
      session === "x11" ? "x11" : "wayland",
      ace,
      viewer,
      { desktopId: calculator, title: "Calculator" },
      cleanups,
    );
    const state = ScreenState.parse(await viewer.request({ op: "start", target }));
    // What the person picked names the session: the app's desktop id, as computer use names it.
    if (target.kind === "chooser")
      expect(state.target).toEqual({
        kind: "chooser",
        picked: expect.objectContaining({ source: "window", bundleId: calculator }),
      });
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
      const started = viewer.request({ op: "start", target: { kind: "chooser" } }, 180_000);
      await expect(started).rejects.toThrow(
        /Nobody chose a window or screen in the sharing dialog within 2 minutes\./,
      );
      expect(await viewer.request({ op: "sessions" })).toEqual([]);
    },
    200_000,
  );

  it.skipIf(session !== "wayland")(
    "stopping a Wayland live view while the sharing dialog waits ends the wait at once",
    async () => {
      const ace = await world();
      const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath);
      cleanups.push(() => viewer.close());
      const started = viewer.request({ op: "start", target: { kind: "chooser" } }, 180_000);
      const outcome = started.then(
        () => "started",
        (error: unknown) => String(error),
      );
      // The viewer sees the session waiting for the person's choice.
      let waiting: ScreenState | undefined;
      for (let tries = 0; !waiting && tries < 100; tries++) {
        const states = ScreenState.array().parse(await viewer.request({ op: "sessions" }));
        waiting = states.find((state) => state.target.kind === "chooser");
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(waiting?.lifecycle).toBe("starting");
      const asked = Date.now();
      await viewer.request({ op: "stop", sessionId: waiting?.sessionId ?? "" });
      expect(await outcome).not.toBe("started");
      expect(Date.now() - asked).toBeLessThan(10_000);
      expect(await viewer.request({ op: "sessions" })).toEqual([]);
    },
    60_000,
  );
});
