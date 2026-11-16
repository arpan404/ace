import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SuitDetail } from "@ace/protocol/suits";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const root = document.documentElement;
const base = "http://127.0.0.1:4242/v1/suits/clip/hash-1/grant/";

/** jsdom has no decoder: play resolves, pause stops, nothing loads. */
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ["data-theme", "data-suit", "data-scheme", "data-surface", "data-density"])
    root.removeAttribute(name);
});

const clip = (
  fields: Record<string, unknown> = {},
  assets: Record<string, string> = {},
): SuitDetail => ({
  ...fakeSuit({
    id: "clip",
    base: "midnight",
    dark: { canvas: "#0a0f1e" },
    video: { sources: ["assets/clip.mp4"], poster: "assets/still.webp", ...fields },
  }),
  assets: {
    "assets/clip.mp4": `${base}assets/clip.mp4`,
    "assets/still.webp": `${base}assets/still.webp`,
    ...assets,
  },
});

const video = () => document.querySelector<HTMLVideoElement>("video[data-suit-video]");
const shell = () => document.querySelector("[data-connection]");

async function open(suit: SuitDetail) {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "clip" }));
  await harness({ storage, suits: fakeSuitLibrary([suit]).transport }).open("/settings/appearance");
}

test("a Suit's video plays behind the shell from the daemon, with its poster, out of the way", async () => {
  await open(clip());
  await waitFor(() => expect(video()).not.toBeNull());
  expect(video()?.getAttribute("src")).toBe(`${base}assets/clip.mp4`);
  expect(video()?.getAttribute("poster")).toBe(`${base}assets/still.webp`);
  // Read with CORS so its frames can colour ace; hidden from assistive tech and the pointer.
  expect(video()?.getAttribute("crossorigin")).toBe("anonymous");
  expect(video()?.getAttribute("aria-hidden")).toBe("true");
  expect(video()?.className).toContain("pointer-events-none");
  await waitFor(() => expect(shell()?.hasAttribute("data-suit-scene")).toBe(true));
  // A veil sits between it and the UI, so text over it reads.
  expect(document.querySelector("[data-suit-veil]")).not.toBeNull();
  expect(document.querySelector('iframe[title="Suit scene"]')).toBeNull();
});

test("a Suit that mutes itself plays without sound", async () => {
  await open(clip({ audio: { muted: true } }));
  await waitFor(() => expect(video()).not.toBeNull());
  expect(video()?.muted).toBe(true);
});

test("a Suit's sound plays at the volume it set", async () => {
  await open(clip({ audio: { volume: 0.4 } }));
  await waitFor(() => expect(video()).not.toBeNull());
  expect(video()?.muted).toBe(false);
  expect(video()?.volume).toBeCloseTo(0.4);
});

test("a hidden window pauses the video and showing it again plays on", async () => {
  await open(clip());
  await waitFor(() => expect(video()).not.toBeNull());
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  const pause = vi.mocked(HTMLMediaElement.prototype.pause);
  await waitFor(() => expect(play).toHaveBeenCalled());
  Object.defineProperty(video(), "paused", { configurable: true, value: false });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(pause).toHaveBeenCalled();
  Object.defineProperty(video(), "paused", { configurable: true, value: true });
  play.mockClear();
  visibility.mockReturnValue("visible");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(play).toHaveBeenCalled();
});

test("a video the daemon can't reach shows nothing, and the Suit keeps its colours", async () => {
  await open({ ...clip(), assets: {} });
  await waitFor(() => expect(root.getAttribute("data-suit")).toBe("clip"));
  expect(video()).toBeNull();
});

test("a video that keeps failing is dropped for that version, and the Suit carries on", async () => {
  await open(clip());
  await waitFor(() => expect(video()).not.toBeNull());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    // The first error with CORS on retries without it (no colours, still a video).
    act(() => void video()?.dispatchEvent(new Event("error")));
    expect(video()?.hasAttribute("crossorigin")).toBe(false);
    // Then three failures in a row drop it.
    for (let attempt = 0; attempt < 3; attempt++) {
      act(() => void video()?.dispatchEvent(new Event("error")));
      act(() => void vi.advanceTimersByTime(5_000));
    }
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(video()).toBeNull());
  expect(root.getAttribute("data-suit")).toBe("clip");
});
