import { facts } from "@ace/fake-daemon";
import type { SuitDetail } from "@ace/protocol/suits";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const root = document.documentElement;
afterEach(() => {
  vi.useRealTimers();
  for (const name of ["data-theme", "data-suit", "data-scheme", "data-surface", "data-density"])
    root.removeAttribute(name);
});

const base = "http://127.0.0.1:4242/v1/suits/party/hash-1/grant-a/";
const party: SuitDetail = {
  ...fakeSuit({ id: "party", dark: { canvas: "#0a0f1e" } }, { scene: true }),
  sceneUrls: { celebration: `${base}confetti.html` },
};

const layer = () => document.querySelector<HTMLElement>("[data-suit-celebration]");
const celebrationFrame = () => layer()?.querySelector("iframe") ?? null;

/** A thread running on screen in the party Suit, and a way to finish its run. */
async function runningThread(appearance: Record<string, unknown> = {}) {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "party", ...appearance }));
  const app = harness({ storage, suits: fakeSuitLibrary([party]).transport });
  const id = "thread-celebrate";
  app.daemon.createThread({ id, title: "Ship it", workspaceId: "ace", provider: "claude" });
  app.daemon.apply(id, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Ship it"),
  ]);
  await app.open(`/t/${id}`);
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("party"));
  const place = await screen.findByRole("navigation", { name: "Projects" });
  await within(place).findByRole("link", { name: /^Ship it/ });
  return {
    app,
    finish: () => act(() => app.daemon.apply(id, [facts.endTurn("root")])),
    again: () => act(() => app.daemon.apply(id, [facts.turn("root")])),
  };
}

/** The scene in the celebration frame says something to the host. */
function fromScene(data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, source: celebrationFrame()?.contentWindow ?? null }),
    );
  });
}

test("the open thread's run finishing plays the Suit's celebration above the UI, untouchable", async () => {
  const { finish } = await runningThread();
  expect(layer()).toBeNull();
  finish();
  await waitFor(() => expect(layer()).not.toBeNull());
  expect(layer()?.getAttribute("data-suit-celebration")).toBe("done");
  // Above the shell, not inside it, and never hit by the pointer.
  expect(layer()?.closest('[data-part="app"]')).toBeNull();
  expect(layer()?.className).toContain("pointer-events-none");
  const frame = celebrationFrame();
  expect(frame?.getAttribute("src")).toBe(`${base}confetti.html`);
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  // Not a backdrop: the live check never samples it under text.
  expect(frame?.hasAttribute("data-suit-scene-frame")).toBe(false);

  // Once the scene says it has played out, it is taken down.
  fromScene({ type: "ready" });
  fromScene({ type: "finished" });
  await waitFor(() => expect(layer()).toBeNull());
});

test("a celebration is taken down after 4 s even if its scene never says it's done", async () => {
  const { finish } = await runningThread();
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  finish();
  await waitFor(() => expect(layer()).not.toBeNull());
  act(() => void vi.advanceTimersByTime(3900));
  expect(layer()).not.toBeNull();
  act(() => void vi.advanceTimersByTime(200));
  await waitFor(() => expect(layer()).toBeNull());
});

test("a second finish within 10 s of the last celebration plays nothing", async () => {
  const { finish, again } = await runningThread();
  finish();
  await waitFor(() => expect(layer()).not.toBeNull());
  fromScene({ type: "ready" });
  fromScene({ type: "finished" });
  await waitFor(() => expect(layer()).toBeNull());
  again();
  finish();
  // Give the list a moment to deliver both changes; nothing mounts.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(layer()).toBeNull();
});

test("under Reduce motion a finished run plays no celebration", async () => {
  const { finish } = await runningThread({ reduceMotion: "on" });
  finish();
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(layer()).toBeNull();
});

test("the layer leaves a hole over every protected part on the page", async () => {
  const { finish } = await runningThread();
  const icon = document.querySelector<HTMLElement>('[data-part="status-icon"]');
  vi.spyOn(icon as HTMLElement, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 20, y: 40, width: 12, height: 12 }),
  );
  finish();
  await waitFor(() => expect(layer()?.style.clipPath).toContain("M14 34H38V58H14Z"));
});
