import { describe, expect, it } from "vitest";
import {
  EncodePacer,
  EncoderWatchdog,
  keyframeGapMs,
  keyframePeriodMs,
  stallMs,
  stillFrameMs,
} from "./video-pacing.ts";

/** Feeds frames at the display's 60 Hz and returns the decisions. */
function run(pacer: EncodePacer, from: number, milliseconds: number) {
  const decisions: { at: number; decision: string }[] = [];
  for (let at = from; at < from + milliseconds; at += 1000 / 60)
    decisions.push({ at, decision: pacer.frame(at, false) });
  return decisions.filter((entry) => entry.decision !== "skip");
}

describe("when the encoder encodes a frame", () => {
  it("starts with a keyframe and then keeps to the encode's frame rate", () => {
    const encoded = run(new EncodePacer(30), 0, 1000);
    expect(encoded[0]?.decision).toBe("key");
    expect(encoded.length).toBeGreaterThanOrEqual(29);
    expect(encoded.length).toBeLessThanOrEqual(31);
    expect(encoded.slice(1).every((entry) => entry.decision === "delta")).toBe(true);
  });

  it("frames arriving a little early or late still make the full frame rate", () => {
    const pacer = new EncodePacer(30);
    let encoded = 0;
    for (let index = 0; index < 60; index++) {
      const jitter = index % 4 === 0 ? 5 : index % 4 === 2 ? -5 : 0;
      if (pacer.frame(index * (1000 / 60) + jitter, false) !== "skip") encoded++;
    }
    expect(encoded).toBeGreaterThanOrEqual(29);
    expect(encoded).toBeLessThanOrEqual(31);
  });

  it("after a pause it starts again at the frame rate, not in a burst", () => {
    const pacer = new EncodePacer(30);
    run(pacer, 0, 1000);
    expect(run(pacer, 5_000, 1000).length).toBeLessThanOrEqual(31);
  });

  it("a slower encode skips more frames", () => {
    expect(run(new EncodePacer(8), 0, 1000).length).toBeLessThanOrEqual(9);
  });

  it("an asked-for keyframe goes with the next frame, but never sooner than the gap allows", () => {
    const pacer = new EncodePacer(30);
    pacer.frame(0, false);
    pacer.requestKeyframe();
    expect(pacer.frame(100, false)).toBe("delta");
    expect(pacer.frame(keyframeGapMs, false)).toBe("key");
    // Several asks in a row are one keyframe.
    pacer.requestKeyframe();
    pacer.requestKeyframe();
    const later = run(pacer, keyframeGapMs * 2, 1000).filter((entry) => entry.decision === "key");
    expect(later).toHaveLength(1);
  });

  it("sends a keyframe at least every period even when nobody asks", () => {
    const keys = run(new EncodePacer(30), 0, keyframePeriodMs * 2 + 100).filter(
      (entry) => entry.decision === "key",
    );
    expect(keys).toHaveLength(3);
  });

  it("a busy encoder takes no frame, and an owed keyframe waits for it", () => {
    const pacer = new EncodePacer(30);
    expect(pacer.frame(0, true)).toBe("skip");
    expect(pacer.frame(40, false)).toBe("key");
  });

  it("a still page's owed keyframe re-encodes the last frame", () => {
    const pacer = new EncodePacer(30);
    pacer.frame(0, false);
    pacer.requestKeyframe();
    expect(pacer.still(keyframeGapMs, keyframeGapMs - stillFrameMs / 2, false)).toBe(false);
    expect(pacer.still(keyframeGapMs, 0, false)).toBe(true);
    // Paid: nothing more is owed.
    expect(pacer.still(keyframeGapMs + 50, 0, false)).toBe(false);
  });
});

describe("telling a stuck encoder from a working one", () => {
  it("an encoder answering its frames is never stuck", () => {
    const watchdog = new EncoderWatchdog();
    for (let at = 0; at < 5_000; at += 33) {
      watchdog.submitted(at);
      watchdog.output();
    }
    expect(watchdog.stalled(5_000)).toBe(false);
  });

  it("an encoder taking frames and answering none is stuck after a while", () => {
    const watchdog = new EncoderWatchdog();
    for (let at = 0; at < stallMs; at += 33) watchdog.submitted(at);
    expect(watchdog.stalled(stallMs - 1)).toBe(false);
    expect(watchdog.stalled(stallMs)).toBe(true);
  });

  it("an idle encoder (a still page) is not stuck", () => {
    expect(new EncoderWatchdog().stalled(60_000)).toBe(false);
  });
});
