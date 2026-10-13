import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("a crashing daemon still writes the log lines it had buffered and the fatal error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-fatal-log-"));
  try {
    await expect(
      promisify(execFile)(process.execPath, [
        join(import.meta.dirname, "testing", "fatal-log-child.ts"),
        directory,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    const records = (await readFile(join(directory, "ace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.message)).toEqual([
      "buffered before crash",
      "Fatal error",
    ]);
    expect(records[1].data.message).toBe("simulated daemon crash");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
