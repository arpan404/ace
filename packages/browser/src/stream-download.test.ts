import { expect, it } from "vitest";
import { decodeStreamMessage, encodeDownloadChunk, StreamAssembler } from "./stream.ts";
import { encodeStream, streamKinds } from "./stream-envelope.ts";

const receive = (pieces: readonly Uint8Array[]) => {
  const assembler = new StreamAssembler();
  const messages = [];
  for (const piece of pieces) {
    const envelope = assembler.push(piece);
    const message = envelope && decodeStreamMessage(envelope);
    if (message) messages.push(message);
  }
  return messages;
};

it("a download chunk larger than one socket message arrives whole, with where it belongs", () => {
  const bytes = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 13) % 256);
  const [message] = receive(
    encodeDownloadChunk(9, {
      threadId: "thread-1",
      downloadId: "download-4",
      offset: 1_048_576,
      size: 5_000_000,
      bytes,
    }),
  );
  expect(message).toMatchObject({
    kind: "browser.download.chunk",
    threadId: "thread-1",
    downloadId: "download-4",
    offset: 1_048_576,
    size: 5_000_000,
  });
  expect(message?.kind === "browser.download.chunk" && message.bytes).toEqual(bytes);
});

it("an empty file's only chunk arrives", () => {
  const [message] = receive(
    encodeDownloadChunk(1, {
      threadId: "thread-1",
      downloadId: "download-1",
      offset: 0,
      size: 0,
      bytes: new Uint8Array(),
    }),
  );
  expect(message).toMatchObject({ kind: "browser.download.chunk", size: 0 });
});

it("a chunk that runs past the file's size is refused", () => {
  const pieces = encodeDownloadChunk(1, {
    threadId: "thread-1",
    downloadId: "download-1",
    offset: 90,
    size: 100,
    bytes: new Uint8Array(20),
  });
  expect(() => receive(pieces)).toThrow("Invalid download header");
});

it("a download header with a wrong length is refused", () => {
  const meta = new Uint8Array(19);
  expect(() =>
    receive(encodeStream(streamKinds.browserDownload, 1, meta, new Uint8Array(1))),
  ).toThrow("Short download header");
});
