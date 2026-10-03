import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CHUNK_SIZE, createBlobExport, createExclusiveRename } from "../src/index.ts";

const home = await mkdtemp(join(tmpdir(), "ace-artifacts-bench-"));
const database = join(home, "source.sqlite");
const db = new DatabaseSync(database);
const exporter = createBlobExport();
const mover = createExclusiveRename();
try {
  const size = 200 * 1024 ** 2;
  const digest = createHash("sha256");
  const zero = Buffer.alloc(CHUNK_SIZE);
  for (let offset = 0; offset < size; offset += zero.length) digest.update(zero);
  const sha256 = digest.digest("hex");
  db.exec("CREATE TABLE blobs(id TEXT PRIMARY KEY, sha256 TEXT, bytes BLOB, thread_id TEXT)");
  db.prepare("INSERT INTO blobs VALUES('raw',?,zeroblob(?),'thread')").run(sha256, size);
  const temporary = join(home, "export.bin");
  let started = performance.now();
  await exporter.export({ database, temporary, rowid: 1, size, sha256 });
  process.stdout.write(
    JSON.stringify({
      mode: "blob-export",
      mibPerSecond: size / 1024 ** 2 / ((performance.now() - started) / 1000),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }) + "\n",
  );
  // Include worker startup in the first measurement; repeated moves reuse its binding.
  started = performance.now();
  const moves = 5000;
  const other = join(home, "other.bin");
  for (let i = 0; i < moves; i++)
    await mover.move(i % 2 === 0 ? temporary : other, i % 2 === 0 ? other : temporary);
  process.stdout.write(
    JSON.stringify({
      mode: "exclusive-rename",
      opsPerSecond: moves / ((performance.now() - started) / 1000),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }) + "\n",
  );
} finally {
  await exporter.close();
  await mover.close();
  db.close();
  await rm(home, { recursive: true, force: true });
}
