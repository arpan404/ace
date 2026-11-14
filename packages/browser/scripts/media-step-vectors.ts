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
const input = (link: number, now: number, probing: boolean, fps = 60): PictureLink => ({
  link,
  pixels,
  fps,
  now,
  probing,
});

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
  ].map((step, i) => ({
    id: `v${i}`,
    viewport: { width: 1280 - i * 10, height: 800 - i * 6, devicePixelRatio: 2 },
    codecs: ["avc1.42001f"],
    ...step,
  }));
  return { input: { source, viewers }, output: planVideo(source, viewers) };
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
