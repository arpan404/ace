import { expect, test } from "vitest";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoundedLog } from "./index.ts";
test("log backpressure keeps only two capped generations even for an oversized chunk", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-log-"));
  try {
    const path = join(root, "daemon.log");
    await pipeline(Readable.from([Buffer.from("abcdefghijklmnopq")]), new BoundedLog(path, 5));
    expect(await readFile(path, "utf8")).toBe("pq");
    expect(await readFile(path + ".previous", "utf8")).toBe("klmno");
    expect((await readdir(root)).toSorted()).toEqual(["daemon.log", "daemon.log.previous"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
