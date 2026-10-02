import { appendFile, readFile, writeFile, rename, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { uploads, hash, attachment, thread, otherThread, png } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(limits: Parameters<typeof uploads>[0] = {}) {
  const value = await uploads(limits);
  cleanups.push(() => value.close());
  return value;
}

describe("resumable uploads", () => {
  test("a daemon restart preserves acknowledged bytes and resumes at the durable offset", async () => {
    const f = await fixture();
    const bytes = Buffer.from("first second"),
      id = await f.begin(bytes);
    await f.chunk(id, bytes.subarray(0, 6));
    await appendFile(join(f.root, "uploads", id), "unacknowledged");
    await f.restart();
    expect(await f.store.handle("device", { op: "upload.status", uploadId: id })).toMatchObject({
      kind: "upload",
      offset: 6,
    });
    await f.chunk(id, bytes.subarray(6), 6);
    const result = attachment(await f.commit(id));
    const blob = await f.store.attachment("device", thread, result.sha256);
    expect(await readFile(blob.path)).toEqual(bytes);
    expect(await f.commit(id)).toEqual({ kind: "attachment", attachment: result });
  });
  test("retrying identical chunks is safe while changed retries and gaps fail", async () => {
    const f = await fixture();
    const bytes = Buffer.from("abcd"),
      id = await f.begin(bytes);
    await f.chunk(id, bytes.subarray(0, 2));
    expect(await f.chunk(id, bytes.subarray(0, 2))).toMatchObject({ offset: 2 });
    await expect(f.chunk(id, Buffer.from("xx"))).rejects.toMatchObject({ code: "offset" });
    await expect(f.chunk(id, Buffer.from("d"), 3)).rejects.toMatchObject({ code: "offset" });
    await expect(f.commit(id)).rejects.toMatchObject({ code: "offset" });
    await f.chunk(id, bytes.subarray(2), 2);
    expect(attachment(await f.commit(id)).sha256).toBe(hash(bytes));
  });
  test("hash mismatches reject the blob and release the reservation", async () => {
    const f = await fixture({ threadBytes: 4 });
    const bytes = Buffer.from("abcd"),
      id = await f.begin(bytes, thread, "0".repeat(64));
    await f.chunk(id, bytes);
    await expect(f.commit(id)).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(await f.store.handle("device", { op: "attachment.list", threadId: thread })).toEqual({
      kind: "attachments",
      attachments: [],
    });
    expect(await f.begin(bytes)).toBeTruthy();
  });
  test("thread quota counts retained blobs and pending uploads", async () => {
    const f = await fixture({ threadBytes: 6 });
    const bytes = Buffer.from("abcd"),
      id = await f.begin(bytes);
    await expect(f.begin(Buffer.from("xxx"))).rejects.toMatchObject({ code: "quota" });
    await f.chunk(id, bytes);
    await f.commit(id);
    await expect(f.begin(Buffer.from("xxx"))).rejects.toMatchObject({ code: "quota" });
    await f.store.handle("device", {
      op: "attachment.release",
      threadId: thread,
      sha256: hash(bytes),
    });
    expect(await f.begin(Buffer.from("xxx"))).toBeTruthy();
  });
  test("global quota reserves bytes across different threads", async () => {
    const f = await fixture({ globalBytes: 6 });
    await f.begin(Buffer.from("abcd"));
    await expect(f.begin(Buffer.from("xxx"), otherThread)).rejects.toMatchObject({ code: "quota" });
  });
  test("entry and file caps reject too many small attachments and oversized files", async () => {
    const f = await fixture({ threadEntries: 1, fileBytes: 3 });
    await expect(f.begin(Buffer.from("four"))).rejects.toMatchObject({ code: "quota" });
    await f.put(Buffer.from("one"));
    await expect(f.begin(Buffer.from("two"))).rejects.toMatchObject({ code: "quota" });
  });
  test("magic-byte sniffing identifies an image despite a lying filename", async () => {
    const f = await fixture();
    const result = attachment(await f.put(png, thread, "document.txt"));
    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(attachment(await f.put(Buffer.from("plain text"), thread, "photo.png")).mimeType).toBe(
      "text/plain",
    );
  });
  test("a huge PNG header is rejected without attempting decompression", async () => {
    const f = await fixture();
    const bomb = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgABhqAAAYagCAQAAAACW8NDAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
      "base64",
    );
    const id = await f.begin(bomb);
    await f.chunk(id, bomb);
    await expect(f.commit(id)).rejects.toMatchObject({
      code: "invalid_image",
      message: expect.stringContaining("dimensions"),
    });
    expect(await f.store.handle("device", { op: "attachment.list", threadId: thread })).toEqual({
      kind: "attachments",
      attachments: [],
    });
  });
  test("truncated images are rejected rather than retained", async () => {
    const f = await fixture();
    const truncated = png.subarray(0, 33),
      id = await f.begin(truncated);
    await f.chunk(id, truncated);
    await expect(f.commit(id)).rejects.toMatchObject({ code: "invalid_image" });
  });
  test("uploads cannot be resumed by another device or after access is revoked", async () => {
    const f = await fixture();
    const id = await f.begin(Buffer.from("abcd"));
    await expect(
      f.store.handle("other-device", { op: "upload.status", uploadId: id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.store.handle("other-device", { op: "attachment.list", threadId: thread }),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.allowed.delete(thread);
    await expect(f.chunk(id, Buffer.from("abcd"))).rejects.toMatchObject({ code: "forbidden" });
  });
  test("expiry cancels abandoned reservations so quota can be used again", async () => {
    const f = await fixture({ threadBytes: 4, ttlMs: 10 });
    const id = await f.begin(Buffer.from("abcd"));
    f.advance(11);
    await f.store.collect();
    await expect(
      f.store.handle("device", { op: "upload.status", uploadId: id }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await f.begin(Buffer.from("abcd"))).toBeTruthy();
  });
  test("collection removes only blobs with no remaining thread references", async () => {
    const f = await fixture();
    const bytes = Buffer.from("shared"),
      shared = attachment(await f.put(bytes));
    await f.put(bytes, otherThread, "shared.bin");
    const lonely = attachment(await f.put(Buffer.from("lonely")));
    const sharedPath = (await f.store.attachment("device", thread, shared.sha256)).path;
    const lonelyPath = (await f.store.attachment("device", thread, lonely.sha256)).path;
    await f.store.handle("device", {
      op: "attachment.release",
      threadId: thread,
      sha256: shared.sha256,
    });
    await f.store.handle("device", {
      op: "attachment.release",
      threadId: thread,
      sha256: lonely.sha256,
    });
    expect(await f.store.collect()).toBe(1);
    expect(await readFile(sharedPath)).toEqual(bytes);
    await expect(access(lonelyPath)).rejects.toThrow();
    await expect(f.store.attachment("device", thread, shared.sha256)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await f.store.attachment("device", otherThread, shared.sha256)).attachment.name).toBe(
      "shared.bin",
    );
    await f.store.releaseThread(otherThread);
    expect(await f.store.collect()).toBe(1);
    await expect(access(sharedPath)).rejects.toThrow();
  });
  test("deduplicating within a thread releases the extra reservation", async () => {
    const f = await fixture({ threadBytes: 8, globalBytes: 8 });
    const bytes = Buffer.from("four");
    await f.put(bytes);
    await f.put(bytes);
    expect(
      await f.store.handle("device", { op: "attachment.list", threadId: thread }),
    ).toMatchObject({ attachments: [{ sha256: hash(bytes) }] });
    expect(await f.begin(Buffer.from("next"))).toBeTruthy();
  });
  test("orphan files are collected in bounded maintenance batches", async () => {
    const f = await fixture();
    const bytes = Buffer.from("retained");
    const blob = attachment(await f.put(bytes));
    const orphan = "f".repeat(64);
    await writeFile(join(f.root, "blobs", orphan), "orphan");
    await writeFile(join(f.root, "uploads", "orphan-upload"), "orphan");
    for (let i = 0; i < 5; i++) await f.store.collect(1);
    await expect(access(join(f.root, "blobs", orphan))).rejects.toThrow();
    await expect(access(join(f.root, "uploads", "orphan-upload"))).rejects.toThrow();
    expect(await readFile((await f.store.attachment("device", thread, blob.sha256)).path)).toEqual(
      bytes,
    );
  });
  test("commit recovers a blob renamed before the metadata transaction completed", async () => {
    const f = await fixture();
    const bytes = Buffer.from("crash window"),
      id = await f.begin(bytes);
    await f.chunk(id, bytes);
    await rename(join(f.root, "uploads", id), join(f.root, "blobs", hash(bytes)));
    await f.restart();
    await f.store.collect();
    expect(attachment(await f.commit(id)).sha256).toBe(hash(bytes));
    expect(await readFile((await f.store.attachment("device", thread, hash(bytes))).path)).toEqual(
      bytes,
    );
  });
  test("noncanonical base64 and chunks over the wire cap never advance offsets", async () => {
    const f = await fixture();
    const id = await f.begin(Buffer.alloc(70_000, 1));
    await expect(
      f.store.handle("device", { op: "upload.chunk", uploadId: id, offset: 0, data: "AB==" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.chunk(id, Buffer.alloc(65_537, 1))).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(await f.store.handle("device", { op: "upload.status", uploadId: id })).toMatchObject({
      offset: 0,
    });
  });
});

test("pixel area limits reject images whose individual sides fit", async () => {
  const f = await fixture();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAJxAAACcQCAQAAAAQR6qsAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
    "base64",
  );
  const id = await f.begin(bytes);
  await f.chunk(id, bytes);
  await expect(f.commit(id)).rejects.toMatchObject({
    code: "invalid_image",
    message: expect.stringContaining("dimensions"),
  });
});
test("corrupt PNG header checksums are rejected before retaining images", async () => {
  const f = await fixture(),
    bytes = Buffer.from(png);
  bytes.writeUInt32BE(0, 29);
  const id = await f.begin(bytes);
  await f.chunk(id, bytes);
  await expect(f.commit(id)).rejects.toMatchObject({
    code: "invalid_image",
    message: expect.stringContaining("checksum"),
  });
});
test("animated GIFs cannot multiply the validated canvas allocation", async () => {
  const f = await fixture();
  const single = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  expect(attachment(await f.put(single)).mimeType).toBe("image/gif");
  const frame = single.subarray(single.indexOf(44), single.length - 1);
  const animated = Buffer.concat([single.subarray(0, -1), frame, Buffer.from([59])]);
  const id = await f.begin(animated);
  await f.chunk(id, animated);
  await expect(f.commit(id)).rejects.toMatchObject({
    code: "invalid_image",
    message: expect.stringContaining("Animated"),
  });
});
test("the store rejects excess queued requests while the accepted upload stays usable", async () => {
  const f = await fixture({ queued: 1 });
  const bytes = Buffer.from("data"),
    first = f.begin(bytes);
  await expect(f.begin(bytes)).rejects.toMatchObject({ code: "busy" });
  const id = await first;
  await f.chunk(id, bytes);
  expect(attachment(await f.commit(id)).sha256).toBe(hash(bytes));
});
test("queued upload operations recheck the transport access boundary before writing", async () => {
  const f = await fixture();
  let permitted = true;
  const operation = f.store.handle(
    "device",
    { op: "upload.begin", threadId: thread, bytes: 1, sha256: "0".repeat(64), name: "file" },
    () => permitted,
  );
  permitted = false;
  await expect(operation).rejects.toMatchObject({ code: "forbidden" });
  expect(await f.store.handle("device", { op: "attachment.list", threadId: thread })).toEqual({
    kind: "attachments",
    attachments: [],
  });
});

test("retrying commit cannot revive a released attachment retained by another thread", async () => {
  const f = await fixture(),
    bytes = Buffer.from("shared"),
    id = await f.begin(bytes);
  await f.chunk(id, bytes);
  await f.commit(id);
  await f.put(bytes, otherThread);
  await f.store.handle("device", {
    op: "attachment.release",
    threadId: thread,
    sha256: hash(bytes),
  });
  await expect(f.commit(id)).rejects.toMatchObject({ code: "not_found" });
  expect(await f.store.handle("device", { op: "attachment.list", threadId: thread })).toEqual({
    kind: "attachments",
    attachments: [],
  });
});

test("global disk quota includes unreferenced blobs until collection reclaims them", async () => {
  const f = await fixture({ globalBytes: 4 }),
    bytes = Buffer.from("data");
  await f.put(bytes);
  await f.store.handle("device", {
    op: "attachment.release",
    threadId: thread,
    sha256: hash(bytes),
  });
  await f.restart();
  await expect(f.begin(Buffer.from("next"))).rejects.toMatchObject({ code: "quota" });
  await f.store.collect();
  expect(await f.begin(Buffer.from("next"))).toBeTruthy();
});

test("deduplication republishes bytes missing after an interrupted collection", async () => {
  const f = await fixture(),
    bytes = Buffer.from("recoverable");
  await f.put(bytes);
  const blob = await f.store.attachment("device", thread, hash(bytes));
  await f.store.handle("device", {
    op: "attachment.release",
    threadId: thread,
    sha256: hash(bytes),
  });
  await rm(blob.path);
  await f.restart();
  await f.put(bytes);
  expect(await readFile((await f.store.attachment("device", thread, hash(bytes))).path)).toEqual(
    bytes,
  );
});

function webpFrame(type: "VP8L" | "VP8 ", width: number, height: number) {
  const payload = Buffer.alloc(type === "VP8L" ? 6 : 10);
  if (type === "VP8L") {
    payload[0] = 47;
    payload.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  } else {
    payload.set([0x9d, 1, 0x2a], 3);
    payload.writeUInt16LE(width, 6);
    payload.writeUInt16LE(height, 8);
  }
  const bytes = Buffer.alloc(30 + 8 + payload.length);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBPVP8X", 8);
  bytes.writeUInt32LE(10, 16);
  bytes.write(type, 30);
  bytes.writeUInt32LE(payload.length, 34);
  payload.copy(bytes, 38);
  return bytes;
}
test("WebP frame dimensions must agree with the validated canvas before retention", async () => {
  const f = await fixture();
  for (const type of ["VP8L", "VP8 "] as const) {
    const bytes = webpFrame(type, 10000, 10000);
    const id = await f.begin(bytes);
    await f.chunk(id, bytes);
    await expect(f.commit(id)).rejects.toMatchObject({ code: "invalid_image" });
  }
  expect(await f.store.handle("device", { op: "attachment.list", threadId: thread })).toEqual({
    kind: "attachments",
    attachments: [],
  });
});

test("a failed durability barrier never acknowledges volatile chunk bytes", async () => {
  let durable = false;
  const f = await uploads(
    {},
    {
      syncChunk: async (file) => {
        if (!durable) throw new Error("storage durability failed");
        await file.sync();
      },
    },
  );
  cleanups.push(f.close);
  const bytes = Buffer.from("durable bytes"),
    id = await f.begin(bytes);
  await expect(f.chunk(id, bytes)).rejects.toThrow("storage durability failed");
  await f.restart();
  expect(await f.store.handle("device", { op: "upload.status", uploadId: id })).toMatchObject({
    offset: 0,
  });
  durable = true;
  await f.chunk(id, bytes);
  expect(attachment(await f.commit(id)).sha256).toBe(hash(bytes));
});
test("oversized PNG dimensions take precedence over corrupt compressed pixels", async () => {
  const f = await fixture();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgABhqAAAYagCAQAAAACW8NDAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
    "base64",
  );
  // Invalid deflate data makes premature inflation observable through the result,
  // without decoding a large raster or imposing a wall-clock budget.
  bytes.fill(0, 41, 52);
  const id = await f.begin(bytes);
  await f.chunk(id, bytes);
  await expect(f.commit(id)).rejects.toMatchObject({
    code: "invalid_image",
    message: expect.stringContaining("dimensions"),
  });
});
test("WebP framing rejects a missing image chunk even with a valid canvas", async () => {
  const f = await fixture();
  const bytes = webpFrame("VP8L", 1, 1);
  bytes.write("JUNK", 30);
  const id = await f.begin(bytes);
  await f.chunk(id, bytes);
  await expect(f.commit(id)).rejects.toMatchObject({ code: "invalid_image" });
  expect(attachment(await f.put(webpFrame("VP8L", 1, 1))).width).toBe(1);
  expect(attachment(await f.put(webpFrame("VP8 ", 1, 1))).height).toBe(1);
});
