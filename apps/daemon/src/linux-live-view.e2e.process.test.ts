/*
 * Linux live view end to end: a person watching a real desktop app. The real Linux screen
 * helper sends JPEG pictures, the daemon re-encodes them to H.264 with the browser service's
 * encoder-only Chrome (ace's pinned build), and a viewer on the daemon WebSocket receives the
 * video exactly as the web and iOS clients do. ffmpeg decodes what arrived, so the assertions
 * are about pictures, not messages. No provider CLI or model runs.
 * Opt-in only: `apps/daemon/scripts/linux-e2e/run.sh` starts a throwaway desktop and sets
 * `ACE_LINUX_DESKTOP_E2E` (x11, wayland, hyprland or sway; KDE sessions set
 * XDG_CURRENT_DESKTOP=KDE) and `ACE_SCREEN_HELPER`. Needs ffmpeg.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ScreenState, type ScreenTarget } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { at, changed, decodeH264 } from "./testing/decode-h264.ts";
import {
  approveInKdeChooser,
  kde,
  shareWindow,
  startShared,
  windowsShared,
} from "./testing/linux-share.ts";
import { LiveViewer, type ViewerFrame } from "./testing/live-viewer.ts";
import {
  answerChooser,
  leaveChooserUnanswered,
  scriptedChooser,
} from "./testing/portal-chooser.ts";

const session = process.env.ACE_LINUX_DESKTOP_E2E;
const helper = process.env.ACE_SCREEN_HELPER;
/** x11 (Openbox or KWin), wayland (GNOME Shell or KWin), hyprland or sway. */
const graphical = ["x11", "wayland", "hyprland", "sway"].includes(session ?? "");
const wayland = graphical && session !== "x11";
/** Wayland desktops whose live view is watch-only: KDE, and portals without RemoteDesktop. */
const watchOnly = wayland && (kde || scriptedChooser);
const enabled = process.platform === "linux" && graphical && !!helper;
/** The desktop's calculator: GNOME's by default, KCalc when the runner made a KDE session. */
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
const video = { codec: "h264", maxWidth: 1920, maxHeight: 1200, fps: 30, bitrate: 4_000_000 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** The viewer's H.264, decoded; kept in ACE_E2E_ARTIFACTS for a person to look at. */
function decode(frames: readonly ViewerFrame[]) {
  const directory = process.env.ACE_E2E_ARTIFACTS;
  return decodeH264(
    frames.map((frame) => frame.bytes),
    directory ? { directory, name: `live-view-${session}${kde ? "-kde" : ""}` } : undefined,
  );
}

async function world(): Promise<EvalWorld> {
  const created = await evalWorld({ browser: true, ...(helper ? { screenHelper: helper } : {}) });
  cleanups.push(() => created.close());
  return created;
}

async function viewerOf(ace: EvalWorld): Promise<LiveViewer> {
  const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath);
  cleanups.push(() => viewer.close());
  return viewer;
}

const shareCalculator = (ace: EvalWorld, viewer: LiveViewer) =>
  shareWindow(
    session ?? "",
    ace,
    viewer,
    { desktopId: calculator, title: desktop.title },
    cleanups,
  );

describe.skipIf(!enabled)(`Linux live view (${session ?? "off"}${kde ? ", KDE" : ""})`, () => {
  it.skipIf(!windowsShared)(
    "a person watching Calculator gets decodable H.264 of its window that changes when the app does",
    async () => {
      const ace = await world();
      expect(ace.browser, "ace's pinned Chrome (ACE_CHROMIUM_PATH) encodes the video").toBe(true);
      const viewer = await viewerOf(ace);
      const shared = await shareCalculator(ace, viewer);
      const state = ScreenState.parse(await startShared(viewer, shared));
      // What the person picked names the session: the app's desktop id, as computer use names it.
      if (shared.target.kind === "chooser")
        expect(state.target).toEqual({
          kind: "chooser",
          picked: expect.objectContaining({ source: "window", bundleId: calculator }),
        });
      await viewer.request({ op: "subscribe", sessionId: state.sessionId });
      // The person's view knows the window's elements by name, as an agent's look does.
      const tree = await viewer.request({
        op: "ui.tree",
        sessionId: state.sessionId,
        maxDepth: 16,
        maxNodes: 512,
      });
      expect(JSON.stringify(tree)).toContain(`"name":"${desktop.keys[0]}"`);
      expect(
        await viewer.request({
          op: "stream.configure",
          sessionId: state.sessionId,
          settings: video,
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
      const expected = shared.size
        ? {
            width: Math.floor(shared.size.width / 2) * 2,
            height: Math.floor(shared.size.height / 2) * 2,
          }
        : { width: first.width, height: first.height };
      // The window alone, never the desktop (at least 1280×800) the runner makes around it. A
      // tiling compositor (Hyprland, Sway) gives the window a full column, so one side may be
      // long, never both.
      expect(expected.width).toBeGreaterThan(200);
      expect(expected.height).toBeGreaterThan(200);
      expect(expected.width < 1280 || expected.height < 800, JSON.stringify(expected)).toBe(true);
      for (const [index, frame] of decoded.entries()) {
        expect({ width: frame.width, height: frame.height }).toEqual(expected);
        expect({ width: after[index]?.width, height: after[index]?.height }).toEqual(expected);
      }
      // The last picture shows the result, which the one before the agent acted didn't.
      expect(changed(at(decoded, before.length - 1), at(decoded, -1))).toBeGreaterThan(
        desktop.resultChange,
      );
    },
    180_000,
  );

  it.skipIf(!watchOnly || !windowsShared)(
    "where the person can only watch (KDE, Hyprland), the view says so and their clicks are refused with the reason",
    async () => {
      const ace = await world();
      const viewer = await viewerOf(ace);
      const state = ScreenState.parse(
        await startShared(viewer, await shareCalculator(ace, viewer)),
      );
      // Clients read this to offer watching only, with the reason, and no take-over.
      const reason = kde ? /KDE's remote control shares the whole desktop/ : /no remote control/;
      expect(state.capabilities?.input).toMatchObject({ pointer: false, keyboard: false });
      expect(String(state.capabilities?.watchOnly)).toMatch(reason);
      await viewer.request({ op: "subscribe", sessionId: state.sessionId });
      await viewer.request({ op: "stream.configure", sessionId: state.sessionId, settings: video });
      expect(await viewer.frames(state.sessionId, { keyframes: 1, count: 1 })).toHaveLength(1);
      await expect(
        viewer.request({ op: "controller", sessionId: state.sessionId, controller: "human" }),
      ).rejects.toThrow(reason);
      // Still watching after the refusal.
      expect(await viewer.request({ op: "sessions" })).toHaveLength(1);
    },
    180_000,
  );

  it.skipIf(!kde || session !== "wayland")(
    "on KDE a person watching the whole screen is asked for the screen alone, and sees all of it",
    async () => {
      const ace = await world();
      const viewer = await viewerOf(ace);
      const target: ScreenTarget = { kind: "display", displayId: 1, bundleIds: ["org.kde.kcalc"] };
      // KDE's screen chooser, not its "Remote Control" request: nothing asks for input.
      const [started] = await Promise.all([
        viewer.request({ op: "start", target }, 150_000),
        approveInKdeChooser("Virtual"),
      ]);
      const state = ScreenState.parse(started);
      expect(state.capabilities?.input).toMatchObject({ pointer: false, keyboard: false });
      await viewer.request({ op: "subscribe", sessionId: state.sessionId });
      await viewer.request({ op: "stream.configure", sessionId: state.sessionId, settings: video });
      const decoded = await decode(
        await viewer.frames(state.sessionId, { keyframes: 1, count: 1 }),
      );
      // The runner's whole 1280×800 desktop, not one window of it.
      expect({ width: at(decoded, 0).width, height: at(decoded, 0).height }).toEqual({
        width: 1280,
        height: 800,
      });
    },
    200_000,
  );

  it.skipIf(windowsShared || !scriptedChooser)(
    "on a desktop that shares whole screens only, watching one app is refused with the reason and the person watches the screen",
    async () => {
      const ace = await world();
      const viewer = await viewerOf(ace);
      await expect(
        viewer.request({
          op: "start",
          target: { kind: "window", bundleId: calculator, windowId: 1 },
        }),
      ).rejects.toThrow(/shares whole screens only/);
      expect(await viewer.request({ op: "sessions" })).toEqual([]);
      await answerChooser("screen");
      const state = ScreenState.parse(
        await viewer.request({
          op: "start",
          target: { kind: "display", displayId: 1, bundleIds: [calculator] },
        }),
      );
      expect(String(state.capabilities?.watchOnly)).toMatch(/no remote control/);
      await viewer.request({ op: "subscribe", sessionId: state.sessionId });
      await viewer.request({ op: "stream.configure", sessionId: state.sessionId, settings: video });
      expect(await viewer.frames(state.sessionId, { keyframes: 1, count: 1 })).toHaveLength(1);
    },
    120_000,
  );

  it.skipIf(!wayland)(
    "a Wayland live view nobody approves on the desktop fails with the reason and leaves nothing running",
    async () => {
      const ace = await world();
      const viewer = await viewerOf(ace);
      await leaveChooserUnanswered();
      // The person comes back and declines, which frees the chooser for whatever runs next.
      cleanups.push(async () => {
        if (scriptedChooser) await answerChooser("cancel");
      });
      const started = viewer.request({ op: "start", target: { kind: "chooser" } }, 180_000);
      await expect(started).rejects.toThrow(
        /Nobody chose a window or screen in the sharing dialog within 2 minutes\./,
      );
      expect(await viewer.request({ op: "sessions" })).toEqual([]);
    },
    200_000,
  );

  it.skipIf(!wayland)(
    "stopping a Wayland live view while the sharing dialog waits ends the wait at once",
    async () => {
      const ace = await world();
      const viewer = await viewerOf(ace);
      await leaveChooserUnanswered();
      cleanups.push(async () => {
        if (scriptedChooser) await answerChooser("cancel");
      });
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
