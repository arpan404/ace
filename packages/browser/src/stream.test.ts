import { describe, expect, it } from "vitest";
import {
  decodeStreamMessage,
  encodeBrowserFrame,
  isStreamPiece,
  StreamAssembler,
  StreamEnvelopeError,
  streamPieceBytes,
  type StreamMessage,
} from "./stream.ts";
import { encodeStream } from "./stream-envelope.ts";

const jpeg = (size: number) => Uint8Array.from({ length: size }, (_, index) => (index * 31) % 251);
const header = { sequence: 41, timestamp: 1_700_000_000_123.5, width: 390, height: 844 };

function receive(
  pieces: readonly Uint8Array[],
): Extract<StreamMessage, { kind: "browser.frame" }>[] {
  const assembler = new StreamAssembler();
  const messages: Extract<StreamMessage, { kind: "browser.frame" }>[] = [];
  for (const piece of pieces) {
    const envelope = assembler.push(piece);
    const message = envelope && decodeStreamMessage(envelope);
    if (message?.kind === "browser.frame") messages.push(message);
  }
  return messages;
}

describe("binary browser frames", () => {
  it("a frame larger than one socket message arrives whole, with its header and exact bytes", () => {
    const picture = jpeg(300_000);
    const pieces = encodeBrowserFrame(7, "thread-1", { ...header, tabId: "tab-2" }, picture);
    expect(pieces.length).toBeGreaterThan(4);
    expect(pieces.every((piece) => piece.length <= streamPieceBytes)).toBe(true);
    expect(pieces.every(isStreamPiece)).toBe(true);
    const [message] = receive(pieces);
    expect(message).toMatchObject({
      kind: "browser.frame",
      threadId: "thread-1",
      frame: { ...header, tabId: "tab-2" },
    });
    expect(message?.frame.bytes).toEqual(picture);
  });

  it("a frame without a tab carries no tab id", () => {
    const [message] = receive(encodeBrowserFrame(1, "thread-1", header, jpeg(10)));
    expect(message?.frame).not.toHaveProperty("tabId");
  });

  it("frames sent back to back each arrive once, in order", () => {
    const pieces = [1, 2, 3].flatMap((sequence) =>
      encodeBrowserFrame(sequence, "thread-1", { ...header, sequence }, jpeg(70_000 + sequence)),
    );
    expect(receive(pieces).map((message) => message.frame.sequence)).toEqual([1, 2, 3]);
  });

  it("a frame cut off by a newer one is dropped, and the newer one still arrives", () => {
    const first = encodeBrowserFrame(1, "thread-1", { ...header, sequence: 1 }, jpeg(150_000));
    const second = encodeBrowserFrame(2, "thread-1", { ...header, sequence: 2 }, jpeg(150_000));
    const messages = receive([...first.slice(0, 1), ...second]);
    expect(messages.map((message) => message.frame.sequence)).toEqual([2]);
  });

  it("a piece out of order is refused rather than stitched into a wrong picture", () => {
    const pieces = encodeBrowserFrame(1, "thread-1", header, jpeg(200_000));
    const assembler = new StreamAssembler();
    assembler.push(pieces[0] ?? new Uint8Array());
    expect(() => assembler.push(pieces[2] ?? new Uint8Array())).toThrow(StreamEnvelopeError);
  });

  it("a piece that claims more than it carries, or isn't a stream piece, is refused", () => {
    const [piece] = encodeBrowserFrame(1, "thread-1", header, jpeg(100));
    if (!piece) throw new Error("No piece");
    const lying = piece.slice();
    new DataView(lying.buffer).setUint32(12, 64 * 1024 * 1024);
    expect(() => new StreamAssembler().push(lying)).toThrow(StreamEnvelopeError);
    const foreign = piece.slice();
    foreign[0] = 0;
    expect(isStreamPiece(foreign)).toBe(false);
    expect(() => new StreamAssembler().push(foreign)).toThrow(StreamEnvelopeError);
  });

  it("a frame header that doesn't name a valid thread is refused", () => {
    const [piece] = encodeBrowserFrame(1, "", header, jpeg(10));
    const envelope = piece && new StreamAssembler().push(piece);
    if (!envelope) throw new Error("No envelope");
    expect(() => decodeStreamMessage(envelope)).toThrow(StreamEnvelopeError);
  });

  it("a stream kind this build doesn't know is skipped, not fatal", () => {
    const pieces = encodeStream(200, 1, new Uint8Array([1, 2]), jpeg(10));
    const envelope = new StreamAssembler().push(pieces[0] ?? new Uint8Array());
    if (!envelope) throw new Error("No envelope");
    expect(decodeStreamMessage(envelope)).toBeUndefined();
  });
});
