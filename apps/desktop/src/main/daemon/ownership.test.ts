import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readOwnership, writeOwnership } from "./ownership.ts";

it("the record written right after start and the one written at quit both land when they overlap", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-ownership-"));
  try {
    const record = { pid: 42, lockId: "run-1", version: "1.0.0", startedAt: 1 };
    await Promise.all([
      writeOwnership(home, record),
      writeOwnership(home, { ...record, startedAt: 2 }),
    ]);
    expect(await readOwnership(home)).toMatchObject({ pid: 42, lockId: "run-1" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
