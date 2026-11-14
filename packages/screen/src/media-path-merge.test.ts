import { expect, it } from "vitest";
import { PathMerge } from "./media-path-merge.ts";

function merge(holdMs = 500) {
  const out: number[] = [];
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  let now = 0;
  const paths = new PathMerge<number>({
    sequence: (frame) => frame,
    emit: (frame) => void out.push(frame),
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    holdMs,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.splice(0))
      if (timer.live && timer.at <= now) timer.run();
      else if (timer.live) timers.push(timer);
  };
  return { paths, out, advance };
}

it("frames on the new path wait until the previous path has delivered its boundary, then follow in order", () => {
  const { paths, out } = merge();
  paths.frame("daemon", 1);
  paths.switching("media");
  // The helper switched after frame 3; ace-media's path is faster than the helper socket.
  paths.frame("media", 4);
  paths.frame("media", 5);
  paths.switched("media", 3);
  paths.frame("daemon", 2);
  expect(out).toEqual([1, 2]);
  paths.frame("daemon", 3);
  paths.frame("media", 6);
  expect(out).toEqual([1, 2, 3, 4, 5, 6]);
});

it("a switch whose boundary never arrives hands the held frames on after the hold", () => {
  const { paths, out, advance } = merge(250);
  paths.frame("media", 1);
  paths.switching("daemon");
  paths.switched("daemon", 2);
  paths.frame("daemon", 3);
  advance(249);
  expect(out).toEqual([1]);
  advance(1);
  expect(out).toEqual([1, 3]);
});

it("a frame older than one already handed on is dropped, never handed on twice", () => {
  const { paths, out } = merge();
  paths.frame("daemon", 1);
  paths.frame("media", 3);
  paths.frame("daemon", 2);
  paths.frame("media", 3);
  expect(out).toEqual([1, 3]);
  expect(paths.stale).toBe(2);
});

it("a switch from a path that took nothing holds nothing", () => {
  const { paths, out } = merge();
  paths.switching("media");
  paths.frame("media", 1);
  expect(out).toEqual([]);
  paths.switched("media", null);
  expect(out).toEqual([1]);
});

it("ace-media's path closing hands on what waited for it at once", () => {
  const { paths, out } = merge();
  paths.frame("media", 1);
  paths.switching("daemon");
  paths.frame("daemon", 4);
  paths.mediaClosed();
  expect(out).toEqual([1, 4]);
});
