import { describe, expect, it } from "vitest";
import { decodeEmbeddedVideo, encodeEmbeddedVideo } from "./embedded-video-wire.ts";

describe("the desktop's video encoder events on its backend socket", () => {
  it("carries a capture's end and an encode's failure unchanged", () => {
    for (const event of [
      { t: "ended", capture: "c-1", reason: "tab closed" },
      { t: "failed", capture: "c-1", encode: "e" },
    ])
      expect(decodeEmbeddedVideo(encodeEmbeddedVideo(event))).toEqual({ header: event });
  });

  it("leaves another channel's binary messages to their owner", () => {
    // A file upload frame on the same socket starts with its own header, not the video's.
    expect(decodeEmbeddedVideo(new Uint8Array([0, 0, 0, 7, 0, 0, 0, 0, 1, 2, 3]))).toBeUndefined();
    expect(decodeEmbeddedVideo(new Uint8Array([0x61, 0x63, 0x65]))).toBeUndefined();
  });

  it("refuses a frame cut short inside its header", () => {
    const frame = encodeEmbeddedVideo({ t: "ended", capture: "c-1" });
    expect(decodeEmbeddedVideo(frame.subarray(0, frame.length - 3))).toBeUndefined();
  });
});
