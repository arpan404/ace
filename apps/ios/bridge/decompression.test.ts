import "./test-native.ts";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFile, type FileReader } from "@ace/client";
import { FILE_READ_PART, ThreadId } from "@ace/protocol";
import { installDecompression } from "./decompression.ts";

/*
 * The phone's JavaScriptCore has no DecompressionStream. With the bridge's native-backed one
 * installed, the shared client asks for gzip file parts and expands them; the stand-in host
 * expands with Node's zlib the way Swift does with the system's.
 */

beforeEach(() => {
  vi.stubGlobal("DecompressionStream", undefined);
  installDecompression();
});
afterEach(() => vi.unstubAllGlobals());

const version = "v1";
/** A daemon's file reads of `text`, gzipped when asked, as the real files service answers. */
function checkout(text: string, corrupt = false) {
  const asked: string[][] = [];
  const reader: FileReader = {
    async request(input) {
      if (input.operation.op !== "read") throw new Error("read only");
      const { offset = 0, length = FILE_READ_PART } = input.operation;
      const encodings = input.operation.encodings ?? [];
      asked.push(encodings);
      const bytes = Buffer.from(text).subarray(offset, offset + length);
      const gzip = encodings.includes("gzip");
      const packed = gzip ? gzipSync(bytes) : bytes;
      // A flipped byte in the gzip trailer's CRC.
      if (corrupt) packed.writeUInt8(packed.readUInt8(packed.length - 5) ^ 0xff, packed.length - 5);
      return {
        type: "files.result",
        requestId: "r",
        value: {
          path: input.operation.path,
          version,
          type: "file",
          size: Buffer.byteLength(text),
          offset,
          encoding: gzip ? "gzip" : "identity",
          data: packed.toString("base64"),
        },
      };
    },
  };
  return { reader, asked };
}
const read = (reader: FileReader) =>
  readFile(reader, { threadId: ThreadId.parse("t"), path: "big.ts", maxSize: 4 * 1024 * 1024 });

test("a file larger than a part is asked for gzipped and arrives whole", async () => {
  const text = "export const value = 'ü';\n".repeat(30_000);
  const c = checkout(text);
  const result = await read(c.reader);
  expect(result.kind === "file" && new TextDecoder().decode(result.bytes)).toBe(text);
  expect(c.asked.length).toBeGreaterThan(1);
  expect(c.asked.every((encodings) => encodings.includes("gzip"))).toBe(true);
});

test("a part that fails its gzip check is a protocol error, never wrong text", async () => {
  const c = checkout("x".repeat(10_000), true);
  await expect(read(c.reader)).rejects.toThrow("protocol");
});
