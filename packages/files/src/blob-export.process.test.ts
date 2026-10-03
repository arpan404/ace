import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { expect, it } from "vitest";
import { CHUNK_SIZE, createBlobExport, decodeFileFrame } from "./index.ts";
import { fixture, isolated } from "./test-support.ts";

it("exports a 200 MiB SQLite raw blob through WebSocket while keeping daemon memory bounded", async () => {
  const f = await fixture();
  const size = 200 * 1024 ** 2;
  const digest = createHash("sha256");
  const zero = Buffer.alloc(CHUNK_SIZE);
  for (let offset = 0; offset < size; offset += zero.length) digest.update(zero);
  const sha256 = digest.digest("hex");
  const db = new DatabaseSync(join(f.root, "source.sqlite"));
  try {
    db.exec("CREATE TABLE blobs(id TEXT PRIMARY KEY, sha256 TEXT, bytes BLOB, thread_id TEXT)");
    db.prepare("INSERT INTO blobs VALUES (?, ?, zeroblob(?), ?)").run(
      "raw",
      sha256,
      size,
      "thread",
    );
  } finally {
    db.close();
  }
  let server: Awaited<ReturnType<typeof isolated>> | undefined;
  try {
    server = await isolated(
      f.root,
      join(f.home, "exporter"),
      new URL("./blob-test-server.ts", import.meta.url),
    );
    const client = server.client;
    client.send({ type: "test.metrics" });
    const baseline = z.object({ peak: z.number() }).parse(await client.next()).peak;
    const result = z
      .object({ value: z.object({ artifactId: z.string() }) })
      .parse(await client.request({ op: "artifact.raw", blobRef: "raw" }));
    const ready = z.object({ channel: z.number(), size: z.number() }).parse(
      await client.request({
        op: "artifact.download",
        artifactId: result.value.artifactId,
        offset: 0,
      }),
    );
    expect(ready.size).toBe(size);
    // Checking the trailer does not retain the blob; the client hashes each credited chunk.
    const received = createHash("sha256");
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
      received.update(decodeFileFrame(z.instanceof(Buffer).parse(await client.next())).bytes);
    }
    expect(received.digest("hex")).toBe(sha256);
    expect(await client.next()).toMatchObject({ type: "files.end", sha256 });
    client.send({ type: "test.metrics" });
    expect(z.object({ peak: z.number() }).parse(await client.next()).peak - baseline).toBeLessThan(
      64 * 1024 ** 2,
    );
  } finally {
    await server?.close();
    await f.close();
  }
}, 120_000);

it("rejects a SQLite blob whose bytes no longer match its stored identity", async () => {
  const f = await fixture();
  const database = join(f.root, "changed.sqlite");
  const db = new DatabaseSync(database);
  const exporter = createBlobExport();
  try {
    db.exec("CREATE TABLE blobs(bytes BLOB)");
    db.prepare("INSERT INTO blobs VALUES (?)").run(Buffer.from("new"));
    await expect(
      exporter.export({
        database,
        temporary: join(f.home, "unpublished"),
        rowid: 1,
        size: 3,
        sha256: createHash("sha256").update("old").digest("hex"),
      }),
    ).rejects.toMatchObject({ code: "CHECKSUM" });
  } finally {
    await exporter.close();
    db.close();
    await f.close();
  }
});
