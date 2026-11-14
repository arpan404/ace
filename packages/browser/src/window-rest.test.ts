import { expect, it } from "vitest";
import { WindowRest } from "./window-rest.ts";

/**
 * A tab's page as CDP shows it: its window state and focus emulation. Replies to the commands
 * named in `held` wait until the test releases them; `failing` commands reject once.
 */
function page() {
  const state = { window: "normal", focused: true };
  const held = new Map<string, PromiseWithResolvers<void>[]>();
  const failing = new Set<string>();
  const sent: string[] = [];
  const hold = (method: string) => {
    const gate = Promise.withResolvers<void>();
    held.set(method, [...(held.get(method) ?? []), gate]);
    return () => gate.resolve();
  };
  const send = async (method: string, params?: Record<string, unknown>) => {
    const gate = held.get(method)?.shift();
    if (gate) await gate.promise;
    if (failing.delete(method)) throw new Error(`${method} failed`);
    sent.push(method);
    if (method === "Browser.getWindowForTarget") return { windowId: 7 };
    if (method === "Browser.setWindowBounds") {
      const bounds = params?.["bounds"] as { windowState: string };
      state.window = bounds.windowState;
    }
    if (method === "Emulation.setFocusEmulationEnabled")
      state.focused = params?.["enabled"] === true;
    return {};
  };
  return { state, hold, failing, sent, rest: new WindowRest(send) };
}
/** Lets every settled promise's callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("a resting page is hidden and unfocused, and shown and focused again on wake", async () => {
  const p = page();
  await p.rest.set(true);
  expect(p.state).toEqual({ window: "minimized", focused: false });
  expect(p.rest.resting).toBe(true);
  await p.rest.set(false);
  expect(p.state).toEqual({ window: "normal", focused: true });
  expect(p.rest.resting).toBe(false);
});

it("wakes asked while the page is still being minimized wait until it is shown again", async () => {
  const p = page();
  const release = p.hold("Browser.setWindowBounds");
  const resting = p.rest.set(true);
  await settle();
  // A viewer and an agent's command both wake the tab during the minimize.
  let woken = 0;
  const viewer = p.rest.set(false).then(() => woken++);
  const command = p.rest.set(false).then(() => woken++);
  await settle();
  expect(woken).toBe(0);
  release();
  await Promise.all([resting, viewer, command]);
  expect(woken).toBe(2);
  expect(p.state).toEqual({ window: "normal", focused: true });
});

it("a wake that asks nothing new still waits for a show under way", async () => {
  const p = page();
  await p.rest.set(true);
  const release = p.hold("Browser.setWindowBounds");
  const first = p.rest.set(false);
  await settle();
  // Nothing looks hidden any more to a second caller, yet the window is not shown yet.
  let second = false;
  const again = p.rest.set(false).then(() => (second = true));
  await settle();
  expect(second).toBe(false);
  release();
  await Promise.all([first, again]);
  expect(p.state).toEqual({ window: "normal", focused: true });
});

it("a rest that turned focus off but failed to minimize gets focus back on the next wake", async () => {
  const p = page();
  p.failing.add("Browser.setWindowBounds");
  await expect(p.rest.set(true)).rejects.toThrow("failed");
  expect(p.state).toEqual({ window: "normal", focused: false });
  // Still partly hidden, so the tab is woken before its next use.
  expect(p.rest.resting).toBe(true);
  await p.rest.set(false);
  expect(p.state).toEqual({ window: "normal", focused: true });
  expect(p.rest.resting).toBe(false);
});

it("a wake that failed to show the window is finished by the next one", async () => {
  const p = page();
  await p.rest.set(true);
  p.failing.add("Browser.setWindowBounds");
  await expect(p.rest.set(false)).rejects.toThrow("failed");
  expect(p.rest.resting).toBe(true);
  await p.rest.set(false);
  expect(p.state).toEqual({ window: "normal", focused: true });
});

it("a page that moved to a new target is left alone by changes asked for the old one", async () => {
  const p = page();
  const release = p.hold("Emulation.setFocusEmulationEnabled");
  const resting = p.rest.set(true);
  await settle();
  p.rest.retire();
  release();
  await resting;
  expect(p.sent).toEqual(["Emulation.setFocusEmulationEnabled"]);
  expect(p.state.window).toBe("normal");
});
