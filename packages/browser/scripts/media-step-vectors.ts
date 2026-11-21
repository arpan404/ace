import { QuantizerControl } from "../src/quantizer-control.ts";

/*
 * ADR 0149's keyframe cap as a shared vector, replayed by `media-core`. The ladder, plan and
 * link vectors beside it in `native/media/vectors` are frozen: their TypeScript was deleted with
 * legacy delivery (X3), so the Rust tests own them.
 */

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
