import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { setup, ready } from "./test-support.ts";
import type { ClientApi } from "./index.ts";

async function upload(client: ClientApi, threadId: string, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { ThreadId } = await import("@ace/protocol");
  const begin = await client.request({
    type: "context.request",
    operation: {
      op: "upload.begin",
      threadId: ThreadId.parse(threadId),
      sha256,
      bytes: bytes.length,
      name: "screen",
    },
  });
  if (begin.result.kind !== "upload") throw new Error("Expected upload");
  for (let offset = 0; offset < bytes.length; offset += 65531)
    await client.request({
      type: "context.request",
      operation: {
        op: "upload.chunk",
        uploadId: begin.result.uploadId,
        offset,
        data: bytes.subarray(offset, offset + 65531).toString("base64"),
      },
    });
  const committed = await client.request({
    type: "context.request",
    operation: { op: "upload.commit", uploadId: begin.result.uploadId },
  });
  expect(committed.result.kind).toBe("attachment");
  return sha256;
}

test("two simultaneously connected daemons resolve attachments through their owning client connections", async () => {
  const a = await setup(),
    b = await setup();
  try {
    const first = a.make().client,
      second = b.make().client;
    await Promise.all([ready(first), ready(second)]);
    const png = await readFile(new URL("../../context/fixtures/colours.png", import.meta.url));
    const jpeg = await readFile(new URL("../../context/fixtures/colours.jpg", import.meta.url));
    const pngHash = await upload(first, a.thread.id, png),
      jpegHash = await upload(second, b.thread.id, jpeg);
    expect(
      Buffer.from(
        (
          await second.attachmentBytes({
            threadId: b.thread.id,
            sha256: jpegHash,
            variant: "original",
            maxBytes: jpeg.length,
          })
        ).bytes,
      ),
    ).toEqual(jpeg);
    expect(
      Buffer.from(
        (
          await first.attachmentBytes({
            threadId: a.thread.id,
            sha256: pngHash,
            variant: "original",
            maxBytes: png.length,
          })
        ).bytes,
      ),
    ).toEqual(png);
    await expect(
      second.attachmentBytes({ threadId: a.thread.id, sha256: pngHash }),
    ).rejects.toThrow();
    await expect(
      first.attachmentBytes({ threadId: b.thread.id, sha256: jpegHash }),
    ).rejects.toThrow();
  } finally {
    await b.cleanup();
    await a.cleanup();
  }
});
