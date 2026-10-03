// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import koffi from "koffi";
import { z } from "zod";
import { BlobExport } from "./blob-export.ts";
import { CHUNK_SIZE, FileError, codeOf } from "./types.ts";

/** Native SQLite's incremental reader owns one read-only snapshot and a fixed 64 KiB buffer. */
async function exportBlob(input: z.infer<typeof BlobExport>): Promise<void> {
  const library = koffi.load(
    process.platform === "darwin"
      ? "/usr/lib/libsqlite3.dylib"
      : process.platform === "linux"
        ? "libsqlite3.so.0"
        : "sqlite3.dll",
  );
  const connect = library.func(
    "int sqlite3_open_v2(const char *path, _Out_ void **database, int flags, const char *vfs)",
  );
  const close = library.func("int sqlite3_close_v2(void *database)");
  const blobOpen = library.func(
    "int sqlite3_blob_open(void *database, const char *db, const char *table, const char *column, int64_t rowid, int flags, _Out_ void **blob)",
  );
  const blobRead = library.func(
    "int sqlite3_blob_read(void *blob, _Out_ uint8_t *bytes, int length, int offset)",
  );
  const blobSize = library.func("int sqlite3_blob_bytes(void *blob)");
  const blobClose = library.func("int sqlite3_blob_close(void *blob)");
  const integer = z.number().int();
  const database: unknown[] = [null];
  const blob: unknown[] = [null];
  const check = (result: unknown) => {
    if (integer.parse(result) !== 0) throw new FileError("CONFLICT", "Blob snapshot unavailable");
  };
  try {
    check(connect(input.database, database, 1, null)); // SQLITE_OPEN_READONLY
    const db = z.bigint().parse(database[0]);
    check(blobOpen(db, "main", "blobs", "bytes", BigInt(input.rowid), 0, blob));
    const handle = z.bigint().parse(blob[0]);
    if (integer.parse(blobSize(handle)) !== input.size)
      throw new FileError("CONFLICT", "Blob size changed");
    const file = await open(input.temporary, "wx", 0o600);
    try {
      const bytes = Buffer.allocUnsafe(CHUNK_SIZE);
      const digest = createHash("sha256");
      for (let offset = 0; offset < input.size; offset += bytes.length) {
        const length = Math.min(bytes.length, input.size - offset);
        check(blobRead(handle, bytes, length, offset));
        const chunk = bytes.subarray(0, length);
        digest.update(chunk);
        await file.writeFile(chunk);
      }
      if (digest.digest("hex") !== input.sha256)
        throw new FileError("CHECKSUM", "Blob identity changed");
      await file.sync();
    } finally {
      await file.close();
    }
  } finally {
    const handle = z.bigint().safeParse(blob[0]);
    if (handle.success) blobClose(handle.data);
    const db = z.bigint().safeParse(database[0]);
    if (db.success) close(db.data);
    library.unload();
  }
}
parentPort?.on("message", (raw: unknown) => {
  void exportBlob(BlobExport.parse(raw)).then(
    () => parentPort?.postMessage({ ok: true }),
    (error: unknown) =>
      parentPort?.postMessage({
        ok: false,
        code: error instanceof FileError ? codeOf(error) : "UNSUPPORTED",
      }),
  );
});
