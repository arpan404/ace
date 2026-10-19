import { describe, expect, it } from "vitest";
import {
  decodeStreamMessage,
  encodeBrowserAudio,
  StreamAssembler,
  StreamEnvelopeError,
  type StreamMessage,
} from "./stream.ts";
import { encodeStream, streamKinds } from "./stream-envelope.ts";

const header = { sequence: 7, timestamp: 1_700_000_000_250.5, sampleRate: 48_000, channels: 2 };

function receive(pieces: readonly Uint8Array[]): StreamMessage[] {
  const assembler = new StreamAssembler();
  return pieces.flatMap((piece) => {
    const envelope = assembler.push(piece);
    const message = envelope && decodeStreamMessage(envelope);
    return message ? [message] : [];
  });
}

describe("binary audio chunks", () => {
  it("an Opus packet arrives with its timestamp, format and tab", () => {
    const packet = Uint8Array.from({ length: 160 }, (_, index) => index);
    const [message] = receive(
      encodeBrowserAudio(1, "thread-1", { ...header, codec: "opus", tabId: "tab-2" }, packet),
    );
    expect(message?.kind).toBe("browser.audio");
    if (message?.kind !== "browser.audio") return;
    expect(message.threadId).toBe("thread-1");
    expect(message.chunk).toMatchObject({ ...header, codec: "opus", tabId: "tab-2" });
    expect(message.chunk.bytes).toEqual(packet);
  });

  it("a chunk without a tab carries none", () => {
    const [message] = receive(
      encodeBrowserAudio(2, "thread-1", { ...header, codec: "opus" }, new Uint8Array(3)),
    );
    if (message?.kind !== "browser.audio") throw new Error("Not an audio chunk");
    expect(message.chunk).not.toHaveProperty("tabId");
  });

  it("a header cut short or claiming an impossible sample rate is refused", () => {
    const short = encodeStream(streamKinds.browserAudio, 4, new Uint8Array(12), new Uint8Array(3));
    expect(() => receive(short)).toThrow(StreamEnvelopeError);
    const meta = encodeBrowserAudio(
      5,
      "thread-1",
      { ...header, codec: "opus" },
      new Uint8Array(3),
    )[0];
    if (!meta) throw new Error("No piece");
    // Rewrite the sample rate (meta offset 16, after the 20-byte piece prefix) to 1 Hz.
    new DataView(meta.buffer).setUint32(20 + 16, 1);
    expect(() => receive([meta])).toThrow(StreamEnvelopeError);
  });
});
