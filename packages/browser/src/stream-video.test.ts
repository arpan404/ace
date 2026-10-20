import { describe, expect, it } from "vitest";
import {
  decodeStreamMessage,
  encodeBrowserFrame,
  encodeBrowserVideo,
  StreamAssembler,
  StreamEnvelopeError,
  streamPieceBytes,
  type StreamMessage,
} from "./stream.ts";
import { encodeStream, streamKinds } from "./stream-envelope.ts";

const header = {
  sequence: 12,
  timestamp: 1_700_000_000_500,
  width: 390,
  height: 844,
  codedWidth: 1170,
  codedHeight: 2532,
  codec: "avc1.42E033",
};
const bytes = (size: number) => Uint8Array.from({ length: size }, (_, index) => (index * 7) % 256);

function receive(pieces: readonly Uint8Array[]): StreamMessage[] {
  const assembler = new StreamAssembler();
  return pieces.flatMap((piece) => {
    const envelope = assembler.push(piece);
    const message = envelope && decodeStreamMessage(envelope);
    return message ? [message] : [];
  });
}

describe("binary video chunks", () => {
  it("a keyframe arrives whole with its codec, sizes and decoder description", () => {
    const description = bytes(42);
    const payload = bytes(150_000);
    const pieces = encodeBrowserVideo(
      3,
      "thread-1",
      { ...header, key: true, description, tabId: "tab-9" },
      payload,
    );
    expect(pieces.every((piece) => piece.length <= streamPieceBytes)).toBe(true);
    const [message] = receive(pieces);
    expect(message?.kind).toBe("browser.video");
    if (message?.kind !== "browser.video") return;
    expect(message.threadId).toBe("thread-1");
    expect(message.chunk).toMatchObject({ ...header, key: true, tabId: "tab-9" });
    expect(message.chunk.description).toEqual(description);
    expect(message.chunk.bytes).toEqual(payload);
  });

  it("a delta carries no description and no tab when it has none", () => {
    const [message] = receive(
      encodeBrowserVideo(4, "thread-1", { ...header, key: false }, bytes(9)),
    );
    if (message?.kind !== "browser.video") throw new Error("Not a video chunk");
    expect(message.chunk.key).toBe(false);
    expect(message.chunk).not.toHaveProperty("description");
    expect(message.chunk).not.toHaveProperty("tabId");
  });

  it("video and JPEG frames interleave on one connection and each arrives as its kind", () => {
    const pieces = [
      ...encodeBrowserFrame(
        1,
        "thread-1",
        { sequence: 1, timestamp: 1, width: 390, height: 844 },
        bytes(70_000),
      ),
      ...encodeBrowserVideo(2, "thread-1", { ...header, key: true }, bytes(70_000)),
    ];
    expect(receive(pieces).map((message) => message.kind)).toEqual([
      "browser.frame",
      "browser.video",
    ]);
  });

  it("a codec string that isn't one is refused", () => {
    const pieces = encodeBrowserVideo(
      5,
      "thread-1",
      { ...header, codec: "avc1<script>", key: true },
      bytes(9),
    );
    expect(() => receive(pieces)).toThrow(StreamEnvelopeError);
  });

  it("a header whose lengths run past its end is refused", () => {
    const meta = new Uint8Array(40);
    new DataView(meta.buffer).setUint8(29, 200);
    const pieces = encodeStream(streamKinds.browserVideo, 6, meta, bytes(9));
    expect(() => receive(pieces)).toThrow(StreamEnvelopeError);
  });
});
