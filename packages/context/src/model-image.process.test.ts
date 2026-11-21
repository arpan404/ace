import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { binaryImages, imagePixels, testMediaBinary } from "@ace/media/testing/images";
import { afterEach, expect, test } from "vitest";
import { ContextService, type ProjectionCapabilities } from "./index.ts";
import { repository, hash, thread } from "./test-support.ts";

/*
 * ADR 0201 §7 with the real ace-media binary (the only image decoder): an image over an inline
 * provider's budget reaches it as a fitted copy within that budget, not as a bare path.
 */

const binary = testMediaBinary();
const photo = new URL(
  "../../../native/media/crates/media-codec/bench/data/still-1206x2622.jpg",
  import.meta.url,
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function composeWith(images: boolean, capabilities: ProjectionCapabilities) {
  const repo = await repository();
  let id = 0;
  const service = await ContextService.open({
    root: join(repo.root, ".git", "ace-context"),
    now: () => 1000,
    id: () => `upload-${++id}`,
    authorize: () => true,
    workspace: () => repo.root,
    ...(images && binary ? { images: binaryImages(binary) } : {}),
  });
  cleanups.push(async () => {
    await service.close();
    await repo.close();
  });
  const bytes = await readFile(photo);
  const begin = await service.handle("device", {
    type: "context.request",
    requestId: "begin",
    operation: {
      op: "upload.begin",
      threadId: thread,
      sha256: hash(bytes),
      bytes: bytes.length,
      name: "screen.jpg",
    },
  });
  if (begin.result.kind !== "upload") throw new Error("Expected upload");
  const uploadId = begin.result.uploadId;
  for (let offset = 0; offset < bytes.length; offset += 65531)
    await service.handle("device", {
      type: "context.request",
      requestId: `chunk-${offset}`,
      operation: {
        op: "upload.chunk",
        uploadId,
        offset,
        data: bytes.subarray(offset, offset + 65531).toString("base64"),
      },
    });
  await service.handle("device", {
    type: "context.request",
    requestId: "commit",
    operation: { op: "upload.commit", uploadId },
  });
  return service.compose(
    "device",
    thread,
    { mentions: [], attachments: [{ sha256: hash(bytes) }] },
    capabilities,
  );
}

const claude = (maxInlineBytes: number): ProjectionCapabilities => ({
  provider: "claude",
  images: ["image/jpeg", "image/png"],
  documents: [],
  embeddedContext: false,
  maxInlineBytes,
});

test.skipIf(!binary)(
  "an image over the provider's inline budget arrives as a copy within the budget and 1568 px",
  async () => {
    // The photo is 205 KB; the provider takes 150 KB inline.
    const result = await composeWith(true, claude(150_000));
    const [part] = result.projection.input;
    if (part?.type !== "image" || !("source" in part) || part.source.type !== "base64")
      throw new Error(`expected an inline image, got ${JSON.stringify(part).slice(0, 200)}`);
    expect(part.source.media_type).toBe("image/jpeg");
    const copy = Buffer.from(part.source.data, "base64");
    expect(copy.length).toBeLessThanOrEqual(150_000);
    const { width, height } = await imagePixels(binaryImages(binary ?? ""), copy);
    expect(Math.max(width, height)).toBe(1568);
    expect(width / height).toBeCloseTo(1206 / 2622, 2);
    expect(result.attachments[0]?.bytes).toBe(205_123);
  },
  30_000,
);

test.skipIf(!binary)(
  "a budget no fitted copy fits sends the image as its path",
  async () => {
    const result = await composeWith(true, claude(2_000));
    const [part] = result.projection.input;
    expect(part).toMatchObject({ type: "text", text: expect.stringContaining("sent as file") });
  },
  30_000,
);

test("without ace-media an image over the budget still goes as its path, as it did", async () => {
  const result = await composeWith(false, claude(150_000));
  const [part] = result.projection.input;
  expect(part).toMatchObject({ type: "text", text: expect.stringContaining("sent as file") });
}, 30_000);
