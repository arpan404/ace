import { afterEach, expect, it, vi } from "vitest";
import type { BrowserCdp, VideoHost } from "./backend.ts";
import { LiveCapture } from "./live.ts";
import type { CaptureViewer } from "./viewer-sink.ts";

afterEach(() => void vi.useRealTimers());

/** A page whose CDP records the screencast starting and stopping. */
function fakePage() {
  const calls: string[] = [];
  const cdp: BrowserCdp = {
    send: async (method: string) => {
      calls.push(method);
      if (method === "Runtime.evaluate") return { result: { value: 1 } };
      if (method === "Page.captureScreenshot") return { data: "" };
      return {};
    },
    on: () => {},
    off: () => {},
  };
  return { cdp, calls };
}

/** An encoder that can't capture the tab itself, so the page's screencast feeds it. */
const picturesHost: VideoHost = {
  mediaKind: "tab-pictures",
  supported: async () => ["avc1.42E033"],
  open: async (_page, width, height) => ({
    encodes: () => {},
    keyframe: () => {},
    close: () => {},
    pictures: { width, height, push: () => {} },
  }),
};

const viewer = (paused: boolean): CaptureViewer => ({
  viewport: { width: 800, height: 600, devicePixelRatio: 1, paused },
  video: { codecs: ["avc1.42E033"] },
});

it("stops the screencast feeding the video once its only viewer is hidden", async () => {
  vi.useFakeTimers();
  const page = fakePage();
  const live = new LiveCapture(
    page.cdp,
    () => Date.now(),
    () => {},
    undefined,
    () => ({ width: 800, height: 600 }),
    () => "tab-1",
    () => 1,
    () => ({ host: picturesHost, page: page.cdp }),
  );
  await live.start();
  live.subscribe("phone", { video: { send: () => true } }, viewer(false));
  await vi.advanceTimersByTimeAsync(500);
  const started = page.calls.lastIndexOf("Page.startScreencast");
  expect(started).toBeGreaterThan(-1);
  expect(page.calls.lastIndexOf("Page.stopScreencast")).toBeLessThan(started);
  live.configure("phone", viewer(true));
  expect(live.watched()).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(page.calls.lastIndexOf("Page.stopScreencast")).toBeGreaterThan(started);
  const stopped = page.calls.length;
  // It stays stopped while the viewer stays hidden, and starts again when it shows.
  await vi.advanceTimersByTimeAsync(10_000);
  expect(page.calls.slice(stopped)).not.toContain("Page.startScreencast");
  live.configure("phone", viewer(false));
  await vi.advanceTimersByTimeAsync(500);
  expect(page.calls.slice(stopped)).toContain("Page.startScreencast");
  await live.close();
});
