import { describe, expect, it } from "vitest";
import { decodeEmbeddedVideo, encodeEmbeddedVideo } from "./embedded-video-wire.ts";

describe("the desktop's video encoder events on its backend socket", () => {
  it("carries an event and its chunk's bytes unchanged", () => {
    const event = { t: "chunk", capture: "c-1", encode: "e", key: true };
    const decoded = decodeEmbeddedVideo(encodeEmbeddedVideo(event, new Uint8Array([0, 1, 255])));
    expect(decoded?.header).toEqual(event);
    expect([...(decoded?.bytes ?? [])]).toEqual([0, 1, 255]);
  });

  it("carries an event without bytes, as a capture's end", () => {
    const decoded = decodeEmbeddedVideo(encodeEmbeddedVideo({ t: "ended", capture: "c-1" }));
    expect(decoded).toEqual({ header: { t: "ended", capture: "c-1" }, bytes: undefined });
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
