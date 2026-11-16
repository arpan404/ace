import { expect, test } from "vitest";
import {
  contrastRatio,
  parseOpaqueColor,
  statusDistance,
  statusGap,
  themes,
  type Rgb,
} from "@ace/themes";
import { inspectSuit, plan, type SuitEntry } from "./folder.ts";
import { suitLimits } from "./limits.ts";
import { revealCeiling } from "./reveal.ts";
import { easeColour, strongestColour, tintedVeil, videoAccent } from "./video-palette.ts";
import { pickVideoSource, videoSizeLabel } from "./video-source.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const manifest = (fields: Record<string, unknown>) =>
  JSON.stringify({ format: 1, id: "clip", name: "Clip", dark: { canvas: "#101014" }, ...fields });

/** A folder: text files read whole, and videos given only by size and time, as lstat sees them. */
function inspect(
  files: Record<string, string>,
  videos: Record<string, { size: number; mtimeMs: number }> = {},
) {
  const map = new Map(Object.entries(files).map(([path, text]) => [path, bytes(text)]));
  const entries: SuitEntry[] = [
    ...[...map].map(([path, data]) => ({ path, kind: "file" as const, size: data.byteLength })),
    ...Object.entries(videos).map(([path, { size, mtimeMs }]) => ({
      path,
      kind: "file" as const,
      size,
      mtimeMs,
    })),
  ];
  const walk = plan(entries);
  return { walk, inspected: inspectSuit("clip", map, walk) };
}

const rgb = (hex: string): Rgb => parseOpaqueColor(hex) ?? [0, 0, 0];

test("a 4 GB video is streamed, not read, and doesn't count toward the assets' total", () => {
  const { walk, inspected } = inspect(
    { "suit.json": manifest({ video: { sources: ["assets/clip.mp4"] } }) },
    { "assets/clip.mp4": { size: 4 * 1024 ** 3, mtimeMs: 1 } },
  );
  expect(walk.read).toEqual(["suit.json"]);
  expect(walk.stream.map((video) => video.path)).toEqual(["assets/clip.mp4"]);
  expect(inspected.summary.problems).toEqual([]);
});

test("a video past the per-file cap, or a fourth video, is refused and never streamed", () => {
  const { walk } = inspect(
    { "suit.json": manifest({}) },
    {
      "assets/a.mp4": { size: suitLimits.videoBytes + 1, mtimeMs: 1 },
      "assets/b.webm": { size: 10, mtimeMs: 1 },
      "assets/c.mov": { size: 10, mtimeMs: 1 },
      "assets/d.m4v": { size: 10, mtimeMs: 1 },
      "assets/e.mp4": { size: 10, mtimeMs: 1 },
    },
  );
  expect(walk.stream.map((video) => video.path)).toEqual([
    "assets/b.webm",
    "assets/c.mov",
    "assets/d.m4v",
  ]);
  expect(walk.problems.map((entry) => entry.field)).toEqual(["assets/a.mp4", "assets/e.mp4"]);
});

test("saving a new cut of the video, even at the same size, makes a new version", () => {
  const files = { "suit.json": manifest({ video: { sources: ["assets/clip.mp4"] } }) };
  const before = inspect(files, { "assets/clip.mp4": { size: 100, mtimeMs: 1000 } });
  const same = inspect(files, { "assets/clip.mp4": { size: 100, mtimeMs: 1000 } });
  const saved = inspect(files, { "assets/clip.mp4": { size: 100, mtimeMs: 2000 } });
  expect(same.inspected.summary.contentHash).toBe(before.inspected.summary.contentHash);
  expect(saved.inspected.summary.contentHash).not.toBe(before.inspected.summary.contentHash);
});

test("a video Suit is told what to fix: a missing source, a poster that isn't an image, an app scene", () => {
  const { inspected } = inspect(
    {
      "suit.json": manifest({
        video: { sources: ["assets/clip.mp4", "assets/gone.mp4"], poster: "assets/still.txt" },
      }),
      "scene.js": "ace.scene({ frame() {} })",
      "assets/still.txt": "not an image",
    },
    { "assets/clip.mp4": { size: 10, mtimeMs: 1 } },
  );
  expect(inspected.summary.problems.map((entry) => [entry.check, entry.field])).toEqual([
    ["video", "video.sources.1"],
    ["video", "video.poster"],
    ["video", "video"],
  ]);
});

test("a source that isn't a video type is refused by the schema", () => {
  const { inspected } = inspect({
    "suit.json": manifest({ video: { sources: ["assets/clip.gif"] } }),
    "assets/clip.gif": "gif",
  });
  expect(inspected.summary.problems.some((entry) => entry.check === "schema")).toBe(true);
});

test("a video Suit's sound defaults on, and the Suit itself can mute it", () => {
  const loud = inspect(
    { "suit.json": manifest({ video: { sources: ["assets/clip.mp4"] } }) },
    { "assets/clip.mp4": { size: 10, mtimeMs: 1 } },
  ).inspected.manifest?.video;
  const quiet = inspect(
    { "suit.json": manifest({ video: { sources: ["assets/clip.mp4"], audio: { muted: true } } }) },
    { "assets/clip.mp4": { size: 10, mtimeMs: 1 } },
  ).inspected.manifest?.video;
  expect(loud?.audio.muted).toBe(false);
  expect(quiet?.audio.muted).toBe(true);
});

const renditions = [
  { path: "assets/2160.mp4", width: 3840, height: 2160 },
  { path: "assets/1080.mp4", width: 1920, height: 1080 },
];

test("the smallest rendition that shows sharp plays: 1080p on a 1080p screen, 4K on a 4K one", () => {
  expect(pickVideoSource(renditions, { width: 1920, height: 1080, fit: "cover" })?.path).toBe(
    "assets/1080.mp4",
  );
  expect(pickVideoSource(renditions, { width: 3456, height: 2234, fit: "cover" })?.path).toBe(
    "assets/2160.mp4",
  );
});

test("with no rendition sharp enough the largest plays, and a file that won't load is never picked", () => {
  expect(pickVideoSource(renditions, { width: 6000, height: 4000, fit: "cover" })?.path).toBe(
    "assets/2160.mp4",
  );
  expect(
    pickVideoSource([{ path: "assets/broken.mp4", width: 0, height: 0 }], {
      width: 100,
      height: 100,
      fit: "cover",
    }),
  ).toBeUndefined();
});

test("a picture is called 4K only when the file has 4K pixels", () => {
  expect(videoSizeLabel({ width: 3840, height: 2160 })).toBe("4K (3840 × 2160)");
  expect(videoSizeLabel({ width: 1920, height: 1080 })).toBe("1080p (1920 × 1080)");
  expect(videoSizeLabel({ width: 640, height: 360 })).toBe("640 × 360");
});

/** A grid of RGBA pixels: `count` of each colour. */
const picture = (...parts: [Rgb, number][]) =>
  parts.flatMap(([[r, g, b], count]) => Array.from({ length: count }, () => [r, g, b, 255]).flat());

test("the picture's strongest colour is the hue most of its coloured area shares", () => {
  const colour = strongestColour(
    picture([[200, 40, 120], 90], [[30, 120, 200], 20], [[10, 10, 10], 40]),
  );
  const [r, g, b] = rgb(colour ?? "#000000");
  expect(r).toBeGreaterThan(b);
  expect(r).toBeGreaterThan(g * 2);
});

test("a grey, black or white picture leaves the Suit's own colours alone", () => {
  expect(
    strongestColour(picture([[128, 128, 128], 50], [[0, 0, 0], 50], [[255, 255, 255], 50])),
  ).toBeUndefined();
});

test("a cut eases over samples instead of flashing to the new colour", () => {
  const step = easeColour("#ff0000", "#0000ff", 0.35);
  expect(step).not.toBe("#0000FF");
  expect(step.toLowerCase()).not.toBe("#ff0000");
  expect(easeColour(undefined, "#0000ff", 0.35)).toBe("#0000ff");
});

test("an accent taken from the picture keeps its labels readable and never passes for a status", () => {
  for (const scheme of ["light", "dark"] as const) {
    const palette = themes.ace[scheme];
    // The done status's own green, and a picture's hot pink.
    for (const colour of [palette.done, "#ff2a8a", "#ffe600"]) {
      const accent = videoAccent(colour, scheme, palette);
      expect(contrastRatio(rgb(accent.accentFg), rgb(accent.accent))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(rgb(accent.accent), rgb(palette.s0))).toBeGreaterThanOrEqual(3);
      expect(statusGap(accent.accent, palette, scheme)).toBeGreaterThanOrEqual(statusDistance);
    }
  }
});

test("the veil's tint never lets the frame's text read worse over any frame than it did untinted", () => {
  for (const scheme of ["light", "dark"] as const) {
    const palette = themes.ace[scheme];
    for (const colour of ["#ff2a8a", "#ffffff", "#000000", "#28e0ff"]) {
      const reveal = 0.65;
      const veil = tintedVeil({
        surface: palette.sidebar,
        text: palette.t1,
        colour,
        tint: 0.25,
        reveal,
      });
      const untinted = revealCeiling({ text: palette.t1, surface: palette.sidebar });
      expect(revealCeiling({ text: palette.t1, surface: veil })).toBeGreaterThanOrEqual(
        Math.min(reveal, untinted),
      );
    }
  }
});

test("the veil takes some of a vivid picture's colour", () => {
  const palette = themes.ace.dark;
  const veil = tintedVeil({
    surface: palette.sidebar,
    text: palette.t1,
    colour: "#ff2a8a",
    tint: 0.12,
    reveal: 0.3,
  });
  expect(veil.toLowerCase()).not.toBe(palette.sidebar.toLowerCase());
});
