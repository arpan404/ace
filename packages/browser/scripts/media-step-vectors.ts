import type { ScreenStreamSettings } from "@ace/protocol";
import { linkCapped } from "../src/link-follow.ts";
import { QuantizerControl } from "../src/quantizer-control.ts";
import { planVideo } from "../src/video-policy.ts";
import { PictureScale, type PictureLink, type PictureStep } from "../src/video-scale.ts";

/*
 * ADR 0149's steps, as shared vectors: the frame rate and size ladder, the keyframe cap, a plan
 * whose viewers stepped, and a view's request held to its link. Replayed by `media-core`.
 */

const pixels = 2560 * 1600;
const input = (
  link: number,
  now: number,
  probing: boolean,
  fps = 60,
  side?: number,
): PictureLink => ({ link, pixels, fps, now, probing, ...(side ? { side } : {}) });

/** One `PictureScale` per scenario, its steps in order. */
function ladder(name: string, inputs: PictureLink[]) {
  const scale = new PictureScale();
  return { name, steps: inputs.map((step) => ({ input: step, output: scale.update(step) })) };
}

export function scaleSteps() {
  const descending = [16e6, 6e6, 4e6, 2.5e6, 2.1e6, 1.6e6, 1e6, 800e3, 400e3, 150e3];
  return [
    // Fps first, then size: a fresh view at each link.
    ...descending.map((link) => ladder(`step order at ${link}`, [input(link, 0, false)])),
    ...descending.map((link) => ladder(`probing at ${link}`, [input(link, 0, true)])),
    ladder("a measured link that thins and recovers", [
      input(16e6, 0, false),
      input(2e6, 100, false),
      input(2e6, 1_100, false),
      input(400e3, 1_300, false),
      input(400e3, 2_400, false),
      input(16e6, 2_500, false),
      input(16e6, 5_500, false),
    ]),
    ladder("probing ends at the first queue", [
      input(1.5e6, 0, true),
      input(2e6, 200, true),
      input(1.2e6, 400, false),
      input(1.2e6, 1_500, false),
    ]),
    // The plan's 3G refinement: shrink at 15 fps to a readable size before 8 and 5 fps.
    ...descending.map((link) => ladder(`readable at ${link}`, [input(link, 0, false, 60, 2560)])),
    // Below the readable size, 15 fps costs what 5 would (the keyframe sets the price).
    ladder("a low link keeps 15 fps at a smaller size", [input(250e3, 0, false, 60, 2560)]),
    ladder("a 10 fps view on a low link keeps its 10 fps", [input(250e3, 0, false, 10, 2560)]),
    ladder("a portrait phone already near readable", [input(1.2e6, 0, false, 60, 1170)]),
    ladder("a 30 fps view, readable", [input(1.2e6, 0, false, 30, 2560)]),
    // Frame-only recovery waits 1 s, not a size step's 3 s.
    ladder(
      "more frames at the same size after 1 s",
      [
        [900e3, 0],
        [2e6, 100],
        [2e6, 1_099],
        [2e6, 1_100],
      ].map(([link, now]) => ({
        link: link ?? 0,
        pixels: 1_000_000,
        fps: 60,
        now: now ?? 0,
        probing: false,
      })),
    ),
    // A higher target restarts the timer: a spike doesn't inherit a smaller step's wait.
    ladder("a spike waits its own time", [
      input(1.2e6, 0, false),
      input(2.2e6, 100, false),
      input(2.2e6, 3_099, false),
      input(16e6, 3_100, false),
      input(16e6, 6_099, false),
      input(16e6, 6_100, false),
    ]),
    ladder("a view that asks for 30 fps", [input(16e6, 0, false, 30), input(1e6, 0, false, 30)]),
  ];
}

/** A 3G encode whose keyframes run large: the cap holds the next ones to half a second. */
export function quantizerCap() {
  const bitrate = 400_000;
  const fps = 5;
  const control = new QuantizerControl(bitrate, fps);
  const steps = Array.from({ length: 30 }, (_, i) => {
    const key = i % 10 === 0;
    const next = control.next(key);
    const bytes = Math.round((key ? 400_000 : 20_000) / 2 ** ((next - 24) / 6));
    control.observe(bytes, key);
    const settled = key && i === 20 ? control.settled() : undefined;
    if (i === 15) control.retarget(200_000, fps);
    return {
      input: { key, bytes, retarget: i === 15 ? 200_000 : null },
      output: { next, settled },
    };
  });
  return { bitrate, fps, steps };
}

export function planSteps() {
  const source = { width: 1280, height: 800, scale: 2, codecs: ["avc1.42001f"] };
  const viewers = [
    { scale: 1, fps: 60, link: 16e6 },
    { scale: 1, fps: 30, link: 3e6 },
    { scale: 0.84, fps: 5, link: 400e3 },
    { scale: 1, fps: 15, link: 2.5e6 },
  ].map((step, i) =>
    Object.assign(
      {
        id: `v${i}`,
        viewport: { width: 1280 - i * 10, height: 800 - i * 6, devicePixelRatio: 2 },
        codecs: ["avc1.42001f"],
      },
      step,
    ),
  );
  return { input: { source, viewers }, output: planVideo(source, viewers) };
}

/**
 * Equal panes that each want their own codec, past the four-encoder limit: which one is left
 * out depends only on the id order (UTF-16 code units), with mixed case and a character above
 * U+FFFF against one just below it.
 */
export function planTies() {
  const ids = ["Z", "a", "b", "c", "d", "\u{1F600}", "\uFF5E"];
  const codecs = ids.map((_, index) => `c${index}`);
  const source = { width: 1280, height: 800, scale: 1, codecs };
  const viewers = ids.map((id, index) => ({
    id,
    viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
    codecs: [codecs[index] ?? ""],
    link: 8_000_000,
  }));
  return [
    {
      input: { source, viewers: viewers.slice(0, 5) },
      output: planVideo(source, viewers.slice(0, 5)),
    },
    { input: { source, viewers: viewers.slice(2) }, output: planVideo(source, viewers.slice(2)) },
  ];
}

export function linkCaps() {
  const asked: ScreenStreamSettings = {
    codec: "h264",
    maxWidth: 1440,
    maxHeight: 2880,
    fps: 60,
    bitrate: 8_000_000,
  };
  const cases: [number | null, PictureStep | null][] = [
    [null, null],
    [30e6, null],
    [3.1e6, null],
    [420e3, null],
    [90e3, null],
    [999_999, { scale: 1, fps: 15 }],
    [400e3, { scale: 0.5, fps: 5 }],
    [400e3, { scale: 0.01, fps: 5 }],
    [16e6, { scale: 1, fps: 60 }],
  ];
  return cases.map(([rate, step]) => ({
    input: { asked, rate, step },
    output: linkCapped(asked, rate ?? undefined, step ?? undefined),
  }));
}
