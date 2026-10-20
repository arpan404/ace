import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

type Failure = "plain" | "disk-full" | "busy-rejection" | "plain-rejection";
async function crash(failure: Failure, exit: { code: number } = { code: 1 }) {
  const directory = await mkdtemp(join(tmpdir(), "ace-fatal-log-"));
  try {
    const child = promisify(execFile)(process.execPath, [
      join(import.meta.dirname, "testing", "fatal-log-child.ts"),
      directory,
      failure,
    ]);
    if (exit.code === 0) await child;
    else await expect(child).rejects.toMatchObject(exit);
    return (await readFile(join(directory, "ace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a crashing daemon still writes the log lines it had buffered and the fatal error", async () => {
  const records = await crash("plain");
  expect(records.map((record) => record.message)).toEqual(["buffered before crash", "Fatal error"]);
  expect(records[1].data.message).toBe("simulated daemon crash");
});

test("a daemon killed by a full disk records the SQLite code and the free space left", async () => {
  const records = await crash("disk-full");
  expect(records[1]).toMatchObject({
    message: "Fatal error",
    data: {
      error: { message: "database or disk is full" },
      sqlite: "SQLITE_FULL",
      freeBytes: expect.any(Number),
    },
  });
});

test("an uncaught rejection from a busy store is logged and the daemon keeps running", async () => {
  const records = await crash("busy-rejection", { code: 0 });
  expect(records.map((record) => record.message)).toEqual([
    "buffered before crash",
    "Unhandled store failure; continuing",
    "still running",
  ]);
  expect(records[1].data.message).toBe("Store is busy");
});

test("any other uncaught rejection is still fatal and logged", async () => {
  const records = await crash("plain-rejection");
  expect(records.map((record) => record.message)).toEqual(["buffered before crash", "Fatal error"]);
  expect(records[1].data.message).toBe("simulated daemon crash");
});
