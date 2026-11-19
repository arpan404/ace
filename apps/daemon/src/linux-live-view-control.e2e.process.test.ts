/*
 * Linux live view, a person in control: they take over a shared window from a viewer, as the
 * web and iOS clients do, and their clicks, wheel and keys reach that window where they put
 * them. The window is the runner's fixture (`scripts/linux-e2e/live-view-fixture.py`), which
 * writes what reaches it to ACE_E2E_FIXTURE_LOG. No provider CLI or model runs.
 * Opt-in only: `apps/daemon/scripts/linux-e2e/run.sh` starts a throwaway desktop.
 */
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenState } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { kde, shareWindow, startShared } from "./testing/linux-share.ts";
import { LiveViewer } from "./testing/live-viewer.ts";

const session = process.env.ACE_LINUX_DESKTOP_E2E;
const helper = process.env.ACE_SCREEN_HELPER;
const log = process.env.ACE_E2E_FIXTURE_LOG;
/** GNOME. KDE and Hyprland are watch-only; the live-view suite checks that they say so. */
const controllable = session === "wayland" && !kde;
const enabled = process.platform === "linux" && controllable && !!helper && !!log;
const fixture = { desktopId: "dev.ace.LiveViewFixture", title: "Live view fixture" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function world(): Promise<EvalWorld> {
  const created = await evalWorld({ browser: false, ...(helper ? { screenHelper: helper } : {}) });
  cleanups.push(() => created.close());
  return created;
}

type Reached = { click?: [number, number, number]; scroll?: [number, number]; key?: string };

/** What reached the fixture after the first `skip` entries, once `found` is among them. */
async function reached(skip: number, found: (entry: Reached) => boolean): Promise<Reached[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const entries = (await readFile(log ?? "", "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Reached)
      .slice(skip);
    if (entries.some(found)) return entries;
    if (Date.now() > deadline)
      throw new Error(`Not reached; the fixture saw ${JSON.stringify(entries)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A click that reached the fixture within 2 points of `x`, `y` with `button`. */
function near(entry: Reached, x: number, y: number, button: number): boolean {
  return (
    !!entry.click &&
    Math.abs(entry.click[0] - x) <= 2 &&
    Math.abs(entry.click[1] - y) <= 2 &&
    entry.click[2] === button
  );
}

async function logged(): Promise<number> {
  return (await readFile(log ?? "", "utf8")).split("\n").filter(Boolean).length;
}

describe.skipIf(!enabled)(`Linux live view control (${session ?? "off"})`, () => {
  it("a person who takes over a shared window clicks, scrolls and types into it where they point", async () => {
    const ace = await world();
    const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath);
    cleanups.push(() => viewer.close());
    const shared = await shareWindow(ace, viewer, fixture, cleanups);
    const { target } = shared;
    const state = ScreenState.parse(await startShared(viewer, shared));
    cleanups.push(async () => {
      await viewer.request({ op: "stop", sessionId: state.sessionId }).catch(() => {});
    });
    if (target.kind === "chooser")
      expect(state.target).toEqual({
        kind: "chooser",
        picked: expect.objectContaining({ source: "window", bundleId: fixture.desktopId }),
      });
    expect(state.capabilities?.input.pointer).toBe(true);
    const sessionId = state.sessionId;
    await viewer.request({ op: "controller", sessionId, controller: "human" });
    const input = (value: Record<string, unknown>) =>
      viewer.request({ op: "input", sessionId, input: value });
    let before = await logged();
    await input({ kind: "pointer.click", x: 100, y: 80, button: "left" });
    await reached(before, (entry) => near(entry, 100, 80, 1));

    before = await logged();
    await input({ kind: "pointer.click", x: 310, y: 230, button: "right" });
    await reached(before, (entry) => near(entry, 310, 230, 3));

    before = await logged();
    await input({ kind: "scroll", x: 200, y: 150, dx: 0, dy: 120 });
    await reached(before, (entry) => (entry.scroll?.[1] ?? 0) > 0);

    before = await logged();
    await input({ kind: "key.press", key: "a", modifiers: [] });
    await reached(before, (entry) => entry.key === "a");

    // A point outside the window is refused, and nothing reaches the window.
    before = await logged();
    await expect(input({ kind: "pointer.click", x: 900, y: 80, button: "left" })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await logged()).toBe(before);
  }, 180_000);

  it("a person's click on a shared window that is behind another app never reaches the app in front", async () => {
    const ace = await world();
    const viewer = await LiveViewer.connect(ace.daemon.url, ace.daemon.tokenPath);
    cleanups.push(() => viewer.close());
    // Calculator opened after the fixture, so GNOME keeps it behind; both sit mid-screen.
    const { target } = await shareWindow(
      ace,
      viewer,
      { desktopId: "org.gnome.Calculator", title: "Calculator" },
      cleanups,
    );
    const state = ScreenState.parse(await viewer.request({ op: "start", target }, 150_000));
    cleanups.push(async () => {
      await viewer.request({ op: "stop", sessionId: state.sessionId }).catch(() => {});
    });
    await viewer.request({ op: "controller", sessionId: state.sessionId, controller: "human" });
    const before = await logged();
    // The middle of Calculator, where the fixture covers it.
    const sent = viewer
      .request({
        op: "input",
        sessionId: state.sessionId,
        input: { kind: "pointer.click", x: 185, y: 300, button: "left" },
      })
      .then(
        () => undefined,
        (error: unknown) => String(error),
      );
    const refusal = await sent;
    // GNOME doesn't let it come forward: the person is told what to do instead.
    if (refusal)
      expect(refusal).toMatch(
        /Calculator is behind another window on that computer.*Bring it to the front there, or share the screen/,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Focus may move as the session's keyboard appears; no input reached the fixture.
    const after = (await readFile(log ?? "", "utf8"))
      .split("\n")
      .filter(Boolean)
      .slice(before)
      .map((line) => JSON.parse(line) as Reached & { active?: boolean });
    expect(after.filter((entry) => entry.active === undefined)).toEqual([]);
  }, 180_000);
});
