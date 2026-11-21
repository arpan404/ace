import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageWork } from "@ace/media/images";
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

async function composeWith(
  images: boolean | ImageWork,
  capabilities: ProjectionCapabilities,
  options: { now?: () => number; photos?: Buffer[] } = {},
) {
  const repo = await repository();
  let id = 0;
  const work =
    typeof images === "object" ? images : images && binary ? binaryImages(binary) : undefined;
  const service = await ContextService.open({
    root: join(repo.root, ".git", "ace-context"),
    now: options.now ?? (() => 1000),
    id: () => `upload-${++id}`,
    authorize: () => true,
    workspace: () => repo.root,
    ...(work ? { images: work } : {}),
  });
  cleanups.push(async () => {
    await service.close();
    await repo.close();
  });
  const photos = options.photos ?? [await readFile(photo)];
  const hashes: string[] = [];
  for (const bytes of photos) hashes.push(await upload(service, bytes));
  return service.compose(
    "device",
    thread,
    { mentions: [], attachments: hashes.map((sha256) => ({ sha256 })) },
    capabilities,
  );
}

async function upload(service: ContextService, bytes: Buffer): Promise<string> {
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
  return hash(bytes);
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

test("oversized images share one preparation deadline; past it the rest go as paths", async () => {
  // Each fit takes 10 s of the injected clock; the turn's preparation has 15 s in all.
  let clock = 0;
  const asked: number[] = [];
  const small = await readFile(
    new URL("../../../native/media/vectors/image/inputs/red-64x48.jpg", import.meta.url),
  );
  const slow: ImageWork = {
    run: async (job) => {
      asked.push(job.deadlineMs);
      clock += 10_000;
      return {
        width: 64,
        height: 48,
        format: "jpeg",
        source: { format: "jpeg", width: 1206, height: 2622, orientation: 1 },
        bytes: small,
      };
    },
  };
  const original = await readFile(photo);
  // Three different pictures, each over the budget: a comment segment after SOI tells them apart.
  const photos = [1, 2, 3].map((n) =>
    Buffer.concat([
      original.subarray(0, 2),
      Buffer.from([0xff, 0xfe, 0, 3, n]),
      original.subarray(2),
    ]),
  );
  const result = await composeWith(slow, claude(150_000), { now: () => clock, photos });
  expect(result.projection.input.map((part) => part.type)).toEqual(["image", "image", "text"]);
  // The second fit was given only what was left of the 15 s, and the third wasn't started.
  expect(asked).toEqual([15_000, 5_000]);
});
