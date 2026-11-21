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
  delivered: true,
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
  live.subscribe("phone", {}, viewer(false));
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

it("a screencast picture captured before the tab's privacy changed never reaches the video; later ones carry their epoch", async () => {
  const page = fakePage();
  let frame: ((raw: unknown) => void) | undefined;
  page.cdp.on = (event: string, listener: (raw: unknown) => void) => {
    if (event === "Page.screencastFrame") frame = listener;
  };
  const pushed: { data: string; epoch: number }[] = [];
  let opened = false;
  const host: VideoHost = {
    ...picturesHost,
    open: async (_page, width, height) => (
      (opened = true),
      {
        encodes: () => {},
        keyframe: () => {},
        close: () => {},
        pictures: { width, height, push: (data, epoch) => void pushed.push({ data, epoch }) },
      }
    ),
  };
  // The person made the tab private at t = 10 s: epoch 1.
  const privacy = { epoch: 1, since: 10_000 };
  const recorded: number[] = [];
  const live = new LiveCapture(
    page.cdp,
    () => 20_000,
    (_frame, epoch) => void recorded.push(epoch),
    () => privacy,
    () => ({ width: 800, height: 600 }),
    () => "tab-1",
    () => 1,
    () => ({ host, page: page.cdp }),
  );
  await live.start();
  live.subscribe("phone", {}, viewer(false));
  await until(() => frame !== undefined && opened);
  const screencast = (data: string, timestamp?: number) =>
    frame?.({
      data,
      sessionId: 1,
      metadata: {
        deviceWidth: 800,
        deviceHeight: 600,
        offsetTop: 0,
        pageScaleFactor: 1,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        ...(timestamp === undefined ? {} : { timestamp }),
      },
    });
  // Captured at 9 s, before the change, and delivered late: dropped. So is one with no capture time.
  screencast("before", 9);
  screencast("unknown");
  // Captured after the change: it goes on, in the epoch it was captured in.
  screencast("after", 11);
  await until(() => pushed.length > 0);
  expect(pushed).toEqual([{ data: "after", epoch: 1 }]);
  expect(recorded).toEqual([1]);
  await live.close();
});

it("after the tab stops being private, ace-media hears the epoch once, and pictures in the read gap keep the private epoch", async () => {
  const page = fakePage();
  let frame: ((raw: unknown) => void) | undefined;
  page.cdp.on = (event: string, listener: (raw: unknown) => void) => {
    if (event === "Page.screencastFrame") frame = listener;
  };
  const pushed: { data: string; epoch: number }[] = [];
  const announced: [number, boolean][] = [];
  let opened = false;
  const host: VideoHost = {
    ...picturesHost,
    open: async (_page, width, height) => (
      (opened = true),
      {
        encodes: () => {},
        keyframe: () => {},
        close: () => {},
        pictures: {
          width,
          height,
          push: (data, epoch) => void pushed.push({ data, epoch }),
          epoch: (privacy, followsPrivate) => void announced.push([privacy.epoch, followsPrivate]),
        },
      }
    ),
  };
  // Private from 10 s (epoch 1).
  const privacy = { epoch: 1, since: 10_000, private: true };
  const recorded: number[] = [];
  const live = new LiveCapture(
    page.cdp,
    () => 30_000,
    (_frame, epoch) => void recorded.push(epoch),
    () => privacy,
    () => ({ width: 800, height: 600 }),
    () => "tab-1",
    () => 1,
    () => ({ host, page: page.cdp }),
  );
  await live.start();
  live.subscribe("phone", {}, viewer(false));
  await until(() => frame !== undefined && opened);
  const screencast = (data: string, timestamp: number) =>
    frame?.({ data, sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600, timestamp } });
  screencast("private", 11);
  // Public again at 20 s (epoch 2): ace-media hears it at once, following a private epoch.
  Object.assign(privacy, { epoch: 2, since: 20_000, private: false });
  live.privacyChanged();
  live.privacyChanged();
  // 50 ms after: inside the read gap, the private epoch. 150 ms after: the public one.
  screencast("gap", 20.05);
  screencast("public", 20.15);
  await until(() => pushed.length === 3);
  // It opened private (epoch 1), so only the change is news to it.
  expect(announced).toEqual([[2, true]]);
  expect(pushed).toEqual([
    { data: "private", epoch: 1 },
    { data: "gap", epoch: 1 },
    { data: "public", epoch: 2 },
  ]);
  await live.close();
});

it("a capture opens in the tab's privacy: a tab already private, and a capture replacing one while private", async () => {
  vi.useFakeTimers();
  const page = fakePage();
  const opens: unknown[] = [];
  const handles: { close: () => void }[] = [];
  const host: VideoHost = {
    ...picturesHost,
    open: async (_page, width, height, events, privacy) => {
      opens.push(privacy);
      const handle = {
        encodes: () => {},
        keyframe: () => {},
        close: () => {},
        pictures: { width, height, push: () => {} },
      };
      // The second capture is the replacement: the first ends under it.
      handles.push({ close: () => events.ended("replaced") });
      return handle;
    },
  };
  // Private before the live view ever opened.
  const privacy = { epoch: 1, since: 1_000, private: true };
  const live = new LiveCapture(
    page.cdp,
    () => Date.now(),
    () => {},
    () => privacy,
    () => ({ width: 800, height: 600 }),
    () => "tab-1",
    () => 1,
    () => ({ host, page: page.cdp }),
  );
  await live.start();
  live.subscribe("phone", {}, viewer(false));
  await vi.advanceTimersByTimeAsync(500);
  expect(opens[0]).toEqual({ epoch: 1, private: true });
  // Still private, a new epoch (public then private again), and the capture is replaced.
  Object.assign(privacy, { epoch: 3, since: 2_000, private: true });
  live.privacyChanged();
  handles[0]?.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(opens.at(-1)).toEqual({ epoch: 3, private: true });
  await live.close();
});

async function until(condition: () => boolean): Promise<void> {
  const end = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
