import { describe, expect, it } from "vitest";
import { DeliveryCandidates } from "./delivery-candidates.ts";

const picture = (name: string, key: boolean, timestamp = 0, size = 10) => ({
  name,
  key,
  timestamp,
  bytes: new Uint8Array(size),
});
const names = (released: { pictures: { name: string }[] }) => released.pictures.map((p) => p.name);

describe("pictures held until a subscribe's reply settles their way", () => {
  it("releases the settled way's newest keyframe and the deltas after it, and drops the other way", () => {
    const held = new DeliveryCandidates<ReturnType<typeof picture>>();
    held.hold("channel", picture("old key", true));
    held.hold("channel", picture("old delta", false));
    held.hold("channel", picture("key", true, 10));
    held.hold("channel", picture("delta", false, 20));
    held.hold("mc_aaaaaaaaaa", picture("media key", true));
    const released = held.settle("channel");
    expect(names(released)).toEqual(["key", "delta"]);
    expect(released.needsKeyframe).toBe(false);
    expect(names(held.settle("mc_aaaaaaaaaa"))).toEqual([]);
  });

  it("drops deltas that have no keyframe before them", () => {
    const held = new DeliveryCandidates<ReturnType<typeof picture>>();
    held.hold("channel", picture("delta", false));
    expect(held.settle("channel")).toEqual({ pictures: [], needsKeyframe: false });
  });

  it("past its bytes it keeps only the keyframe and asks for a fresh one", () => {
    const held = new DeliveryCandidates<ReturnType<typeof picture>>({ bytes: 100, ms: 2_000 });
    held.hold("channel", picture("key", true, 0, 60));
    held.hold("channel", picture("delta 1", false, 10, 30));
    held.hold("channel", picture("delta 2", false, 20, 30));
    // The gap stays open: later deltas can't follow the one dropped.
    held.hold("channel", picture("delta 3", false, 30, 1));
    const released = held.settle("channel");
    expect(names(released)).toEqual(["key"]);
    expect(released.needsKeyframe).toBe(true);
  });

  it("a new keyframe after an overflow starts the way afresh", () => {
    const held = new DeliveryCandidates<ReturnType<typeof picture>>({ bytes: 100, ms: 2_000 });
    held.hold("channel", picture("key", true, 0, 90));
    held.hold("channel", picture("delta", false, 10, 30));
    held.hold("channel", picture("next key", true, 20, 10));
    expect(held.settle("channel")).toMatchObject({ needsKeyframe: false });
  });
});
