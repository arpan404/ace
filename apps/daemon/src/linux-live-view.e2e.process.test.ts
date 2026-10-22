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
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenInventory, ScreenState, type ScreenTarget } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { at, changed, decodeH264 } from "./testing/decode-h264.ts";
import { LiveViewer, type ViewerFrame } from "./testing/live-viewer.ts";

const session = process.env.ACE_LINUX_DESKTOP_E2E;
const helper = process.env.ACE_SCREEN_HELPER;
const graphical = session === "x11" || session === "wayland";
const enabled = process.platform === "linux" && graphical && !!helper;
const exec = promisify(execFile);
/** The desktop's calculator: GNOME's by default, KCalc when the runner made a KDE session. */
const kde = (process.env.XDG_CURRENT_DESKTOP ?? "").split(":").includes("KDE");
const desktop = kde
  ? {
      calculator: "org.kde.kcalc",
      title: "KCalc",
      keys: ["Seven", "Multiply", "Six", "Equals"],
      // KCalc writes its result small: "42" is about 90 of the window's 325,000 pixels.
      resultChange: 0.0001,
    }
  : {
      calculator: "org.gnome.Calculator",
      title: "Calculator",
      keys: ["7", "×", "6", "="],
      resultChange: 0.001,
    };
const calculator = desktop.calculator;

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

const tests = new URL("../../../native/screen-helper-linux/tests/computer/", import.meta.url)
  .pathname;
const seedPortal = join(tests, "seed_portal.py");
const portalDialog = join(tests, "portal_dialog.py");

/** A Wayland window target: the portal's chooser, not the id, decides what is shared. */
const waylandCalculator: ScreenTarget = {
  kind: "window",
  bundleId: kde ? "kcalc" : "gnome-calculator",
  windowId: 1,
};

/**
 * The window a person picks. X11 lists Calculator's window. Wayland lists nothing: the portal's
 * chooser picks the source. GNOME's chooser can't be answered through accessibility, so the
 * test records the approval the person would give there (test scaffolding only; ace never writes
 * the permission store) for the helper to restore. KDE's chooser can: `approve` picks the window
 * in it while the live view starts, as the person would.
 */
async function calculatorWindow(
  ace: EvalWorld,
  viewer: LiveViewer,
): Promise<{
  target: ScreenTarget;
  size?: { width: number; height: number };
  approve?: () => Promise<unknown>;
}> {
  const inventory = ScreenInventory.parse(await viewer.request({ op: "targets" }));
  if (session === "x11") {
    const window = inventory.windows.find((entry) => entry.title === desktop.title);
    if (!window?.bounds) throw new Error(`No Calculator window: ${JSON.stringify(inventory)}`);
    return {
      target: { kind: "window", bundleId: window.bundleId, windowId: window.windowId },
      size: { width: window.bounds.width, height: window.bounds.height },
    };
  }
  expect(inventory).toEqual({ displays: [], windows: [] });
  if (kde) {
    return {
      target: waylandCalculator,
      approve: () => exec("python3", [portalDialog, "approve", desktop.title]),
    };
  }
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
    const { target, size, approve } = await calculatorWindow(ace, viewer);
    const [started] = await Promise.all([
      viewer.request({ op: "start", target }, 60_000),
      approve?.(),
    ]);
    const state = ScreenState.parse(started);
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
        ...desktop.keys.map((key) => ({ type: "click", id: id(key) })),
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
    expect(changed(at(decoded, before.length - 1), at(decoded, -1))).toBeGreaterThan(
      desktop.resultChange,
    );
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
