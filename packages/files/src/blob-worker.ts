// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { cString, openLibrary, pointerSlot } from "@ace/provider-kit/bun-ffi";
import { windowsSystemExecutable } from "@ace/provider-kit/process-owner";
import { BlobExport } from "./blob-export.ts";
import { CHUNK_SIZE, FileError, codeOf } from "./types.ts";

/**
 * Windows ships its own SQLite as System32\winsqlite3.dll on every supported x64 and ARM64
 * release. A bare "sqlite3.dll" would load whatever copy sits first on PATH, if any. System32
 * comes from the kernel, never from an environment variable a caller can set.
 */
function sqliteLibrary(): string {
  if (process.platform === "darwin") return "/usr/lib/libsqlite3.dylib";
  if (process.platform === "linux") return "libsqlite3.so.0";
  return windowsSystemExecutable("winsqlite3.dll");
}
/** Native SQLite's incremental reader owns one read-only snapshot and a fixed 64 KiB buffer. */
async function exportBlob(input: z.infer<typeof BlobExport>): Promise<void> {
  const library = openLibrary(sqliteLibrary(), {
    sqlite3_open_v2: { args: ["ptr", "ptr", "i32", "ptr"], returns: "i32" },
    sqlite3_close_v2: { args: ["ptr"], returns: "i32" },
    sqlite3_blob_open: {
      args: ["ptr", "ptr", "ptr", "ptr", "i64", "i32", "ptr"],
      returns: "i32",
    },
    sqlite3_blob_read: { args: ["ptr", "ptr", "i32", "i32"], returns: "i32" },
    sqlite3_blob_bytes: { args: ["ptr"], returns: "i32" },
    sqlite3_blob_close: { args: ["ptr"], returns: "i32" },
  });
  const sqlite = library.symbols;
  const integer = z.number().int();
  const database = pointerSlot();
  const blob = pointerSlot();
  const check = (result: unknown) => {
    if (integer.parse(result) !== 0) throw new FileError("CONFLICT", "Blob snapshot unavailable");
  };
  try {
    // SQLITE_OPEN_READONLY
    check(sqlite.sqlite3_open_v2(cString(input.database), database.slot, 1, null));
    const db = z.number().parse(database.value());
    check(
      sqlite.sqlite3_blob_open(
        db,
        cString("main"),
        cString("blobs"),
        cString("bytes"),
        BigInt(input.rowid),
        0,
        blob.slot,
      ),
    );
    const handle = z.number().parse(blob.value());
    if (integer.parse(sqlite.sqlite3_blob_bytes(handle)) !== input.size)
      throw new FileError("CONFLICT", "Blob size changed");
    const file = await open(input.temporary, "wx", 0o600);
    try {
      const bytes = Buffer.allocUnsafe(CHUNK_SIZE);
      const digest = createHash("sha256");
      for (let offset = 0; offset < input.size; offset += bytes.length) {
        const length = Math.min(bytes.length, input.size - offset);
        check(sqlite.sqlite3_blob_read(handle, bytes, length, offset));
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
    const handle = blob.value();
    if (handle !== null) sqlite.sqlite3_blob_close(handle);
    // sqlite3_open_v2 returns a handle even when it fails; it must be closed either way.
    const db = database.value();
    if (db !== null) sqlite.sqlite3_close_v2(db);
    library.close();
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
