import { describe, expect, it } from "vitest";
import { VideoChunkGate } from "./video-gate.ts";

/** A socket that takes chunks while `open` is true and records what it took. */
function socket() {
  const sent: string[] = [];
  let open = true;
  return {
    sent,
    set open(value: boolean) {
      open = value;
    },
    send: (label: string) => () => {
      if (open) sent.push(label);
      return open;
    },
  };
}

describe("video chunks on a backed-up backend socket", () => {
  it("sends every chunk while the socket keeps up", () => {
    const gate = new VideoChunkGate();
    const link = socket();
    for (const [label, key] of [
      ["k1", true],
      ["d1", false],
      ["d2", false],
    ] as const)
      expect(gate.offer("c", "e", key, link.send(label))).toEqual({ sent: true, keyframe: false });
    expect(link.sent).toEqual(["k1", "d1", "d2"]);
  });

  it("drops deltas after a refused one until a keyframe gets through, asking for it once", () => {
    const gate = new VideoChunkGate();
    const link = socket();
    gate.offer("c", "e", true, link.send("k1"));
    link.open = false;
    expect(gate.offer("c", "e", false, link.send("d1")).keyframe).toBe(true);
    link.open = true;
    // The socket drained, but these deltas follow the lost one: undecodable.
    expect(gate.offer("c", "e", false, link.send("d2"))).toEqual({ sent: false, keyframe: false });
    expect(gate.offer("c", "e", true, link.send("k2"))).toEqual({ sent: true, keyframe: false });
    gate.offer("c", "e", false, link.send("d3"));
    expect(link.sent).toEqual(["k1", "k2", "d3"]);
  });

  it("asks again when the keyframe it waited for is refused too", () => {
    const gate = new VideoChunkGate();
    const link = socket();
    link.open = false;
    gate.offer("c", "e", false, link.send("d1"));
    expect(gate.offer("c", "e", true, link.send("k1")).keyframe).toBe(true);
  });

  it("keeps an encode's gap from holding back another encode of the same capture", () => {
    const gate = new VideoChunkGate();
    const link = socket();
    link.open = false;
    gate.offer("c", "small", false, link.send("small-d1"));
    link.open = true;
    expect(gate.offer("c", "large", false, link.send("large-d1")).sent).toBe(true);
    expect(gate.offer("c", "small", false, link.send("small-d2")).sent).toBe(false);
  });
});
