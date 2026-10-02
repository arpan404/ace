import { createHash } from "node:crypto";
import { open, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { CHUNK_SIZE, decodeFileFrame, encodeFileFrame } from "./index.ts";
import { fixture, isolated, type Client } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  cleanup.push(() => f.close());
  return f;
}
const Ready = z.object({
  type: z.literal("files.ready"),
  channel: z.number(),
  validator: z.string(),
  size: z.number().nullable(),
  offset: z.number(),
});
const End = z.object({ type: z.literal("files.end"), offset: z.number(), sha256: z.string() });
const Upload = z.object({
  type: z.literal("files.upload"),
  channel: z.number(),
  uploadId: z.string(),
  offset: z.number(),
  size: z.number(),
});
async function receive(
  client: Client,
  channel: number,
  digest: ReturnType<typeof createHash>,
  offset: number,
  totalSize: number,
) {
  let position = offset;
  for (;;) {
    client.send({ type: "files.credit", channel, credits: 1 });
    const message = await client.next();
    if (!Buffer.isBuffer(message)) {
      const trailer = End.parse(message);
      expect(trailer.offset).toBe(position);
      return trailer;
    }
    const frame = decodeFileFrame(message);
    expect(frame.channel).toBe(channel);
    expect(frame.offset).toBe(position);
    digest.update(frame.bytes);
    position += frame.bytes.length;
    // Known-size downloads send the trailer immediately after their final frame.
    if (position === totalSize) {
      const trailer = End.parse(await client.next());
      expect(trailer.offset).toBe(position);
      return trailer;
    }
  }
}

it("streams a 200 MiB binary to a slow reader with bounded daemon RSS and no uncredited bytes", async () => {
  const f = await setup();
  const size = 200 * 1024 * 1024;
  const file = await open(join(f.root, "large.bin"), "w");
  await file.truncate(size);
  await file.close();
  const server = await isolated(f.root, join(f.home, "isolated"));
  cleanup.push(() => server.close());
  const client = server.client;
  const ready = Ready.parse(await client.request({ op: "download", path: "large.bin", offset: 0 }));
  expect(ready.size).toBe(size);
  client.send({ type: "test.metrics" });
  const baseline = z
    .object({ type: z.literal("test.metrics"), peak: z.number(), rss: z.number() })
    .parse(await client.next());
  // A control roundtrip is a barrier: no binary frame may precede it without credits.
  client.send({ type: "test.metrics" });
  expect(await client.next()).toMatchObject({ type: "test.metrics" });
  const digest = createHash("sha256");
  const trailer = await receive(client, ready.channel, digest, 0, size);
  const receivedHash = digest.digest("hex");
  const expected = createHash("sha256");
  const zeros = Buffer.alloc(CHUNK_SIZE);
  for (let offset = 0; offset < size; offset += zeros.length) expected.update(zeros);
  expect(receivedHash).toBe(expected.digest("hex"));
  expect(trailer.sha256).toBe(receivedHash);
  client.send({ type: "test.metrics" });
  const peak = z.object({ peak: z.number() }).parse(await client.next()).peak;
  expect(peak - baseline.peak).toBeLessThan(64 * 1024 * 1024);
}, 120_000);

it("resumes after disconnect byte-exactly and rejects a changed file", async () => {
  const f = await setup();
  const bytes = Buffer.alloc(5 * CHUNK_SIZE);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(join(f.root, "binary"), bytes);
  const first = await f.connect();
  const ready = Ready.parse(await first.request({ op: "download", path: "binary", offset: 0 }));
  first.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  const frame = z.instanceof(Buffer).parse(await first.next());
  const prefix = decodeFileFrame(frame).bytes;
  await first.close();
  const second = await f.connect();
  const resumed = Ready.parse(
    await second.request({
      op: "download",
      path: "binary",
      offset: prefix.length,
      validator: ready.validator,
    }),
  );
  const full = createHash("sha256").update(prefix);
  const suffix = await receive(second, resumed.channel, full, prefix.length, bytes.length);
  expect(full.digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(suffix.sha256).toBe(
    createHash("sha256").update(bytes.subarray(prefix.length)).digest("hex"),
  );
  await writeFile(join(f.root, "binary"), Buffer.alloc(bytes.length, 42));
  expect(
    await second.request({
      op: "download",
      path: "binary",
      offset: prefix.length,
      validator: ready.validator,
    }),
  ).toMatchObject({ type: "files.error", code: "CONFLICT" });
  expect(
    await second.request({ op: "download", path: "binary", offset: prefix.length }),
  ).toMatchObject({ type: "files.error", code: "CONFLICT" });
});

it("resumes uploads across daemon restart and exposes only the atomically committed file", async () => {
  const f = await setup();
  const first = await f.connect();
  const bytes = Buffer.alloc(2 * CHUNK_SIZE, 177);
  const upload = Upload.parse(
    await first.request({
      op: "upload.begin",
      path: "new.bin",
      expected: null,
      size: bytes.length,
    }),
  );
  first.socket.send(encodeFileFrame(upload.channel, 0, bytes.subarray(0, CHUNK_SIZE)));
  expect(await first.next()).toMatchObject({ type: "files.upload", offset: CHUNK_SIZE });
  await expect(stat(join(f.root, "new.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  await f.restart();
  const second = await f.connect();
  const resumed = Upload.parse(
    await second.request({ op: "upload.resume", uploadId: upload.uploadId }),
  );
  expect(resumed.offset).toBe(CHUNK_SIZE);
  second.socket.send(encodeFileFrame(resumed.channel, resumed.offset, bytes.subarray(CHUNK_SIZE)));
  expect(await second.next()).toMatchObject({ type: "files.upload", offset: bytes.length });
  await expect(stat(join(f.root, "new.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  const response = await second.request({
    op: "upload.commit",
    uploadId: upload.uploadId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(response).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "new.bin"))).toEqual(bytes);
  expect(second.changes).toContainEqual(
    expect.objectContaining({ change: expect.objectContaining({ op: "upload", path: "new.bin" }) }),
  );
});

it("rejects upload checksum, offset, quota and overwrite conflicts without changing the destination", async () => {
  const f = await setup({ maxUploadBytes: 10, maxReservedBytes: 10 });
  const client = await f.connect();
  expect(
    await client.request({ op: "upload.begin", path: "bad", expected: null, size: 11 }),
  ).toMatchObject({ code: "QUOTA" });
  const upload = Upload.parse(
    await client.request({ op: "upload.begin", path: "result", expected: null, size: 3 }),
  );
  client.socket.send(encodeFileFrame(upload.channel, 1, Buffer.from("bad")));
  expect(await client.next()).toMatchObject({ type: "files.error", code: "QUOTA" });
  client.socket.send(encodeFileFrame(upload.channel, 1, Buffer.from("x")));
  expect(await client.next()).toMatchObject({ type: "files.error", code: "OFFSET" });
  client.socket.send(encodeFileFrame(upload.channel, 0, Buffer.from("abc")));
  expect(await client.next()).toMatchObject({ offset: 3 });
  expect(
    await client.request({
      op: "upload.commit",
      uploadId: upload.uploadId,
      sha256: "0".repeat(64),
    }),
  ).toMatchObject({ code: "CHECKSUM" });
  await writeFile(join(f.root, "result"), "agent edit");
  expect(
    await client.request({
      op: "upload.commit",
      uploadId: upload.uploadId,
      sha256: createHash("sha256").update("abc").digest("hex"),
    }),
  ).toMatchObject({ code: "CONFLICT" });
  expect(await readFile(join(f.root, "result"), "utf8")).toBe("agent edit");
});

it("caps concurrent downloads and frees a slot on cancellation", async () => {
  const f = await setup({ maxTransfers: 1 });
  await writeFile(join(f.root, "a"), "data");
  const client = await f.connect();
  const ready = Ready.parse(await client.request({ op: "download", path: "a", offset: 0 }));
  expect(await client.request({ op: "download", path: "a", offset: 0 })).toMatchObject({
    code: "BUSY",
  });
  client.send({ type: "files.cancel", channel: ready.channel });
  expect(await client.next()).toMatchObject({ type: "files.cancelled" });
  expect(await client.request({ op: "download", path: "a", offset: 0 })).toMatchObject({
    type: "files.ready",
  });
});
it("waits for each credit before sending more bytes and rejects an oversized credit window", async () => {
  const f = await setup();
  const file = await open(join(f.root, "binary"), "w");
  await file.truncate(3 * CHUNK_SIZE);
  await file.close();
  const server = await isolated(f.root, join(f.home, "credit-server"));
  cleanup.push(() => server.close());
  const client = server.client;
  const ready = Ready.parse(await client.request({ op: "download", path: "binary", offset: 0 }));
  client.send({ type: "test.metrics" });
  expect(await client.next()).toMatchObject({ type: "test.metrics" });
  client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  expect(decodeFileFrame(z.instanceof(Buffer).parse(await client.next())).bytes.length).toBe(
    CHUNK_SIZE,
  );
  client.send({ type: "test.metrics" });
  expect(await client.next()).toMatchObject({ type: "test.metrics" });
  client.send({ type: "files.credit", channel: ready.channel, credits: 9 });
  expect(await client.next()).toMatchObject({ code: "INVALID_MESSAGE" });
});
it("refuses a successful trailer if the file changes during a paused transfer", async () => {
  const f = await setup();
  const client = await f.connect();
  await writeFile(join(f.root, "a"), Buffer.alloc(2 * CHUNK_SIZE, 1));
  const ready = Ready.parse(await client.request({ op: "download", path: "a", offset: 0 }));
  client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  expect(Buffer.isBuffer(await client.next())).toBe(true);
  await writeFile(join(f.root, "a"), Buffer.alloc(2 * CHUNK_SIZE, 2));
  client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  expect(Buffer.isBuffer(await client.next())).toBe(true);
  expect(await client.next()).toMatchObject({ type: "files.error", code: "CONFLICT" });
});
