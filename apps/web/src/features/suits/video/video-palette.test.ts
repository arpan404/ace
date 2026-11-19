import { SuitVideo } from "@ace/protocol/suits";
import { themes } from "@ace/themes";
import { expect, test } from "vitest";
import { shownFrame } from "./video-frame.ts";
import { createPaletteSampler, paletteEveryMs, videoTokens } from "./video-palette.ts";

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
      const end = now + ms;
      for (;;) {
        const next = pending.toSorted((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        now = next.at;
        pending.splice(pending.indexOf(next), 1);
        next.run();
      }
      now = end;
    },
  };
}

const frameOf = (r: number, g: number, b: number) =>
  Array.from({ length: 16 * 9 }, () => [r, g, b, 255]).flat();

const pink = () => frameOf(220, 40, 130);
const cyan = () => frameOf(30, 200, 230);

function sampled(frames: (() => number[] | undefined)[]) {
  const timers = fakeTimers();
  const shown: (string | undefined)[] = [];
  let at = 0;
  const sampler = createPaletteSampler({
    read: () => (frames[Math.min(at++, frames.length - 1)] ?? (() => undefined))(),
    show: (colour) => shown.push(colour),
    after: timers.after,
  });
  return { sampler, timers, shown, reads: () => at };
}

test("while the video plays, ace's colour follows the picture and eases across a cut", () => {
  const { sampler, timers, shown } = sampled([pink, pink, cyan, cyan, cyan, cyan, cyan, cyan]);
  sampler.run("playing");
  timers.advance(paletteEveryMs);
  const afterPink = shown.at(-1);
  timers.advance(paletteEveryMs);
  const firstStepToCyan = shown.at(-1);
  timers.advance(paletteEveryMs * 5);
  const settled = shown.at(-1);
  expect(firstStepToCyan).not.toBe(afterPink);
  // One sample moves only part of the way; later ones carry on toward it.
  expect(firstStepToCyan).not.toBe(settled);
});

test("under Reduce motion one colour is taken and held: nothing samples on a beat", () => {
  const { sampler, timers, shown, reads } = sampled([() => frameOf(220, 40, 130)]);
  sampler.run("still");
  timers.advance(paletteEveryMs * 10);
  expect(reads()).toBe(1);
  expect(shown).toHaveLength(1);
});

test("a paused video stops sampling, and its colour stays", () => {
  const { sampler, timers, shown, reads } = sampled([() => frameOf(220, 40, 130)]);
  sampler.run("playing");
  sampler.run("paused");
  const before = reads();
  timers.advance(paletteEveryMs * 10);
  expect(reads()).toBe(before);
  expect(shown.at(-1)).toBeDefined();
});

test("a frame the page can't read puts the Suit's own colours back and stops trying", () => {
  let reads = 0;
  const timers = fakeTimers();
  const shown: (string | undefined)[] = [];
  const sampler = createPaletteSampler({
    read: () => {
      reads += 1;
      if (reads === 1) return frameOf(220, 40, 130);
      throw new DOMException("tainted", "SecurityError");
    },
    show: (colour) => shown.push(colour),
    after: timers.after,
  });
  sampler.run("playing");
  timers.advance(paletteEveryMs * 10);
  expect(shown.at(-1)).toBeUndefined();
  expect(reads).toBe(2);
});

test("taking the video down puts the Suit's own colours back", () => {
  const { sampler, shown } = sampled([() => frameOf(220, 40, 130)]);
  sampler.run("playing");
  sampler.dispose();
  expect(shown.at(-1)).toBeUndefined();
});

const follow = (palette: object = {}) =>
  SuitVideo.parse({ sources: ["assets/clip.mp4"], palette }).palette;

test("the video's colour sets only the accent and the veil, never a status or the danger fill", () => {
  const tokens = videoTokens({
    colour: "#e02880",
    scheme: "dark",
    palette: themes.ace.dark,
    follow: follow(),
    reveal: 0.65,
  });
  const names = Object.keys(tokens);
  expect(names).toContain("--ring");
  expect(names).toContain("--suit-video-veil");
  expect(names.filter((name) => /status|danger|destructive|needs|failed/.test(name))).toEqual([]);
});

test("a Suit can keep its own accent and only tint the veil, or neither", () => {
  const tintOnly = videoTokens({
    colour: "#e02880",
    scheme: "light",
    palette: themes.ace.light,
    follow: follow({ accent: false }),
    reveal: 0.3,
  });
  expect(Object.keys(tintOnly)).toEqual(["--suit-video-veil"]);
  const neither = videoTokens({
    colour: "#e02880",
    scheme: "light",
    palette: themes.ace.light,
    follow: follow({ accent: false, tint: 0 }),
    reveal: 0.3,
  });
  expect(neither).toEqual({});
});

test("a covered frame reads the part of the picture on screen, not the cropped sides", () => {
  // A 16:9 video in a square box: the middle 9:9 shows.
  const shown = shownFrame(
    { width: 1600, height: 900 },
    { left: 0, top: 0, width: 900, height: 900 },
    "cover",
  );
  expect(shown).toMatchObject({ sx: 350, sy: 0, sw: 900, sh: 900 });
  const contained = shownFrame(
    { width: 1600, height: 900 },
    { left: 0, top: 0, width: 800, height: 800 },
    "contain",
  );
  expect(contained?.box).toEqual({ left: 0, top: 175, width: 800, height: 450 });
});
