import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, test } from "vitest";
import { ContextService } from "./index.ts";
import { ContextRequest } from "@ace/protocol";

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
    return sharp(path).resize(32, 24).png().toBuffer();
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
  const f = await previews(async () =>
    sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: ++renderEpoch, g: 0, b: 0 } },
    })
      .png()
      .toBuffer(),
  );
  const hashes: string[] = [];
  try {
    for (let n = 0; n < 9; n++)
      hashes.push(
        await f.upload(
          await sharp({
            create: { width: 16, height: 16, channels: 3, background: { r: n, g: 0, b: 0 } },
          })
            .png()
            .toBuffer(),
        ),
      );
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
