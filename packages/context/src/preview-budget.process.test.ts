import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { ContextService } from "./index.ts";
import { ContextRequest } from "@ace/protocol";

/** Nine different images ace previews, from the context and image vector fixtures. */
const distinctImages = [
  "../fixtures/colours.png",
  "../fixtures/colours.jpg",
  "../fixtures/colours.webp",
  "../fixtures/colours.gif",
  ...["red-64x48.jpg", "alpha-32x32.png", "palette-8x8.png", "icon-64.png", "screen-20x40.png"].map(
    (name) => `../../../native/media/vectors/image/inputs/${name}`,
  ),
];

async function previews(render: (path: string) => Promise<Buffer>) {
  const root = await mkdtemp(join(tmpdir(), "ace-preview-budget-"));
  let id = 0;
  const service = await ContextService.open({
    root,
    now: () => 1000,
    id: () => `id-${++id}`,
    workspace: () => undefined,
    authorize: () => true,
    renderThumbnail: render,
  });
  const read = (hash: string) =>
    service.handle(
      "reader",
      ContextRequest.parse({
        type: "context.request",
        requestId: `read-${++id}`,
        operation: {
          op: "attachment.read",
          threadId: "thread",
          sha256: hash,
          variant: "thumbnail",
        },
      }),
    );
  return {
    service,
    read,
    async upload(bytes: Buffer) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const begin = await service.uploads.handle("reader", {
        op: "upload.begin",
        threadId: "thread",
        sha256,
        bytes: bytes.length,
        name: "image.png",
      });
      if (begin.kind !== "upload") throw new Error("Expected upload");
      for (let offset = 0; offset < bytes.length; offset += 65531)
        await service.uploads.handle("reader", {
          op: "upload.chunk",
          uploadId: begin.uploadId,
          offset,
          data: bytes.subarray(offset, offset + 65531).toString("base64"),
        });
      await service.uploads.handle("reader", { op: "upload.commit", uploadId: begin.uploadId });
      return sha256;
    },
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("only two image decodes are admitted concurrently and their slots recover after completion", async () => {
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  let active = 0;
  const fixture = await readFile(new URL("../fixtures/colours.png", import.meta.url));
  const f = await previews(async (path) => {
    if (++active === 2) entered.resolve();
    if (active <= 2) await gate.promise;
    return Buffer.from(`preview of ${path}`);
  });
  try {
    const hash = await f.upload(fixture);
    const secondHash = await f.upload(
      await readFile(new URL("../fixtures/colours.jpg", import.meta.url)),
    );
    const thirdHash = await f.upload(
      await readFile(new URL("../fixtures/colours.webp", import.meta.url)),
    );
    const first = f.read(hash),
      second = f.read(secondHash);
    await entered.promise;
    const excess = await f.read(thirdHash);
    gate.resolve();
    expect(excess.result).toMatchObject({ kind: "error", code: "busy" });
    expect((await first).result.kind).toBe("attachment.data");
    expect((await second).result.kind).toBe("attachment.data");
    expect((await f.read(hash)).result.kind).toBe("attachment.data");
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("preview churn retains eight recent previews and evicts the least recently read image", async () => {
  let renderEpoch = 0;
  // The renderer stands in for ace-media; what matters is how often it is asked.
  const f = await previews(async () => Buffer.from([++renderEpoch]));
  const hashes: string[] = [];
  try {
    for (const name of distinctImages)
      hashes.push(await f.upload(await readFile(new URL(name, import.meta.url))));
    const oldest = hashes[0],
      recent = hashes[1];
    if (!oldest || !recent) throw new Error("Missing fixtures");
    const initial = await f.read(oldest);
    expect(await f.read(oldest)).toEqual(expect.objectContaining({ result: initial.result }));
    const retained = await f.read(recent);
    for (const hash of hashes.slice(2))
      expect((await f.read(hash)).result.kind).toBe("attachment.data");
    expect((await f.read(recent)).result).toEqual(retained.result);
    // The injected renderer makes regeneration externally distinguishable from a cache hit.
    const regenerated = await f.read(oldest);
    expect(regenerated.result.kind).toBe("attachment.data");
    expect(regenerated.result).not.toEqual(initial.result);
  } finally {
    await f.close();
  }
});
