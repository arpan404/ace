import { expect, test } from "vitest";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoundedLog } from "./index.ts";
test("log rotation keeps only two capped generations even for an oversized chunk", async () => {
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

test("a saturated log refuses more producer data until accepted bytes reach disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-log-pressure-"));
  const path = join(root, "output.log"),
    log = new BoundedLog(path, 128 * 1024);
  try {
    const payload = Buffer.alloc(64 * 1024, 42);
    const drained = once(log, "drain");
    expect(log.write(payload)).toBe(false);
    expect(log.writableLength).toBe(payload.length);
    await drained;
    expect(log.writableLength).toBe(0);
    expect(await readFile(path)).toEqual(payload);
    const closed = once(log, "close");
    log.end();
    await closed;
  } finally {
    log.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
