import { expect, test } from "vitest";
import {
  createVideoController,
  positionEveryMs,
  storedPosition,
  type VideoElementLike,
  type VideoFacts,
} from "./video-controller.ts";

/** A `<video>` without a decoder: it plays unless sound is refused without a gesture. */
function fakeVideo(options: { refuseSound?: boolean; duration?: number } = {}) {
  const element: VideoElementLike & { paused: boolean; loads: number } = {
    muted: false,
    volume: 1,
    currentTime: 0,
    duration: options.duration ?? 200,
    paused: true,
    loads: 0,
    play() {
      if (options.refuseSound && !element.muted) {
        const error = new Error("play() needs a user gesture");
        error.name = "NotAllowedError";
        return Promise.reject(error);
      }
      element.paused = false;
      return Promise.resolve();
    },
    pause() {
      element.paused = true;
    },
    load() {
      element.loads += 1;
    },
  };
  return element;
}

function fakeTimers() {
  const pending: { at: number; run: () => void }[] = [];
  let now = 0;
  return {
    after(ms: number, run: () => void) {
      const entry = { at: now + ms, run };
      pending.push(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    advance(ms: number) {
      now += ms;
      for (const entry of pending.filter((item) => item.at <= now)) {
        pending.splice(pending.indexOf(entry), 1);
        entry.run();
      }
    },
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const onScreen: VideoFacts = { visible: true, still: false, savingPower: false };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function controlled(
  element: ReturnType<typeof fakeVideo>,
  audio = { muted: false, volume: 0.6 },
  storage = memoryStorage(),
) {
  const timers = fakeTimers();
  let stopped = 0;
  const controller = createVideoController({
    element,
    audio,
    position: storedPosition(storage, "position"),
    after: timers.after,
    stopped: () => void (stopped += 1),
  });
  return { controller, timers, storage, stopped: () => stopped };
}

test("the video plays only while the window is visible and motion and power allow", () => {
  const element = fakeVideo();
  const { controller } = controlled(element);
  controller.facts(onScreen);
  expect(element.paused).toBe(false);
  controller.facts({ ...onScreen, visible: false });
  expect(element.paused).toBe(true);
  controller.facts(onScreen);
  expect(element.paused).toBe(false);
  controller.facts({ ...onScreen, still: true });
  expect(element.paused).toBe(true);
  controller.facts({ ...onScreen, savingPower: true });
  expect(element.paused).toBe(true);
});

test("the Suit's own audio settings decide the sound, capped at its volume", () => {
  const quiet = fakeVideo();
  controlled(quiet, { muted: true, volume: 0.3 });
  expect(quiet.muted).toBe(true);
  expect(quiet.volume).toBe(0.3);
  const loud = fakeVideo();
  controlled(loud, { muted: false, volume: 0.8 });
  expect(loud.muted).toBe(false);
  expect(loud.volume).toBe(0.8);
});

test("a browser that refuses sound without a gesture plays it muted, and sounds it on the first click", async () => {
  const element = fakeVideo({ refuseSound: true });
  const { controller } = controlled(element);
  controller.facts(onScreen);
  await flush();
  expect(element.paused).toBe(false);
  expect(element.muted).toBe(true);
  expect(controller.waitingForGesture()).toBe(true);
  controller.gesture();
  expect(element.muted).toBe(false);
  expect(controller.waitingForGesture()).toBe(false);
});

test("a Suit that mutes itself stays muted after a click", async () => {
  const element = fakeVideo({ refuseSound: true });
  const { controller } = controlled(element, { muted: true, volume: 0.6 });
  controller.facts(onScreen);
  await flush();
  controller.gesture();
  expect(element.muted).toBe(true);
  expect(element.paused).toBe(false);
});

test("a reload picks the video up where it was, wrapping when a new cut is shorter", () => {
  const storage = memoryStorage();
  const first = fakeVideo();
  const one = controlled(first, undefined, storage);
  one.controller.facts(onScreen);
  first.currentTime = 73.4;
  one.controller.dispose();

  const again = fakeVideo();
  controlled(again, undefined, storage).controller.loaded();
  expect(again.currentTime).toBe(73.4);

  const shorter = fakeVideo({ duration: 60 });
  controlled(shorter, undefined, storage).controller.loaded();
  expect(shorter.currentTime).toBeCloseTo(13.4);
});

test("the position is written at most every few seconds while it plays", () => {
  const element = fakeVideo();
  const { controller, storage } = controlled(element);
  element.currentTime = 1;
  controller.progressed(0);
  element.currentTime = 2;
  controller.progressed(positionEveryMs - 1);
  expect(storage.getItem("position")).toBe("1");
  element.currentTime = 6;
  controller.progressed(positionEveryMs);
  expect(storage.getItem("position")).toBe("6");
});

test("a video that fails is tried again, and dropped after its third failure", () => {
  const element = fakeVideo();
  const { controller, timers, stopped } = controlled(element);
  controller.facts(onScreen);
  controller.failed();
  timers.advance(1_000);
  expect(element.loads).toBe(1);
  controller.failed();
  timers.advance(4_000);
  expect(element.loads).toBe(2);
  expect(stopped()).toBe(0);
  controller.failed();
  expect(stopped()).toBe(1);
  controller.facts(onScreen);
  timers.advance(10_000);
  expect(element.loads).toBe(2);
});

test("a video that loads after failing starts its count again", () => {
  const element = fakeVideo();
  const { controller, timers, stopped } = controlled(element);
  controller.failed();
  timers.advance(1_000);
  controller.failed();
  timers.advance(4_000);
  controller.loaded();
  controller.failed();
  controller.failed();
  expect(stopped()).toBe(0);
});
