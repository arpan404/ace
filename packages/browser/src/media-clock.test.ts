import { describe, expect, it } from "vitest";
import { MediaClock } from "./media-clock.ts";

describe("captured sound on the video's clock", () => {
  it("follows the quickest arrival: sound that waited in a buffer keeps its capture time", () => {
    const clock = new MediaClock();
    // 10 ms buffers stamped on the media clock (µs); the first one sat 30 ms in a queue.
    expect(clock.arrived(5_000_000, 1_030)).toBe(1_030);
    // The next arrived only 5 ms after capture: the mapping moves to it.
    expect(clock.arrived(5_010_000, 1_015)).toBe(1_015);
    // A later buffer that waited 25 ms is put back at its capture time, not its arrival.
    expect(clock.arrived(5_020_000, 1_050)).toBe(1_025);
    // Encoded chunks carry the media timestamps of their first sample.
    expect(clock.map(5_015_000)).toBe(1_020);
  });

  it("starts a new mapping when the media clock jumps", () => {
    const clock = new MediaClock();
    clock.arrived(5_000_000, 1_000);
    // The capture restarted its timestamps: half a second of media time vanished.
    expect(clock.arrived(100_000, 1_010)).toBe(1_010);
    expect(clock.map(110_000)).toBe(1_020);
  });

  it("maps nothing before the first sound", () => {
    expect(new MediaClock().map(1_000)).toBeUndefined();
  });
});
