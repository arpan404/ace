import { describe, expect, it } from "vitest";
import {
  EncodePacer,
  EncoderWatchdog,
  keyframeGapMs,
  keyframePeriodMs,
  settleMs,
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

  it("a page that goes still gets its last picture encoded once more, once per still spell", () => {
    const pacer = new EncodePacer(60);
    const moving = run(pacer, 0, 1000);
    const last = moving.at(-1)?.at ?? 0;
    expect(pacer.settle(last + settleMs - 1, last, true)).toBe(false);
    expect(pacer.settle(last + settleMs, last, true)).toBe(true);
    expect(pacer.settle(last + settleMs * 3, last, true)).toBe(false);
    // The page changed and went still again: another one.
    const again = run(pacer, 5_000, 200).at(-1)?.at ?? 0;
    expect(pacer.settle(again + settleMs, again, true)).toBe(true);
  });

  it("a still page's sharper picture waits for a busy encoder, and an owed keyframe goes first", () => {
    const pacer = new EncodePacer(60);
    pacer.frame(0, false);
    pacer.frame(20, false);
    expect(pacer.settle(20 + settleMs, 20, false)).toBe(false);
    pacer.requestKeyframe();
    expect(pacer.settle(keyframeGapMs, 20, true)).toBe(false);
    expect(pacer.still(keyframeGapMs, 20, false)).toBe(true);
    expect(pacer.settle(keyframeGapMs + settleMs, 20, true)).toBe(true);
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

describe("a skipped last frame on a page that goes still", () => {
  it("is encoded once its slot comes, though no other frame arrives", () => {
    const pacer = new EncodePacer(30);
    expect(pacer.frame(0, false)).toBe("key");
    // A keystroke's frame lands 10 ms later, before the next slot: skipped. The page is still
    // after it.
    expect(pacer.frame(10, false)).toBe("skip");
    expect(pacer.catchUp(12, false)).toBe(false);
    expect(pacer.catchUp(30, false)).toBe(true);
    // Once sent, nothing more is owed.
    expect(pacer.catchUp(90, false)).toBe(false);
  });

  it("waits while the encoder is busy, then goes", () => {
    const pacer = new EncodePacer(30);
    pacer.frame(0, false);
    expect(pacer.frame(50, true)).toBe("skip");
    expect(pacer.catchUp(60, true)).toBe(false);
    expect(pacer.catchUp(70, false)).toBe(true);
  });

  it("is not owed when the frame that went was the newest", () => {
    const pacer = new EncodePacer(30);
    pacer.frame(0, false);
    expect(pacer.frame(40, false)).toBe("delta");
    expect(pacer.catchUp(200, false)).toBe(false);
  });
});
