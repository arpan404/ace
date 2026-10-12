import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { storageFixture } from "./test-support.ts";

test("a daemon crash resumes accepted removals without repeating completed effects", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-storage-crash-")));
  let f = await storageFixture(root);
  try {
    const first = await f.file("logs/ace.1.jsonl");
    const second = await f.file("logs/ace.2.jsonl");
    const plan = await f.storage.plan("owner");
    await f.close();
    await expect(
      promisify(execFile)(process.execPath, [
        join(import.meta.dirname, "crash-worker.ts"),
        root,
        plan.id,
        plan.revision,
      ]),
    ).rejects.toMatchObject({ code: 86 });
    await expect(access(first)).rejects.toMatchObject({ code: "ENOENT" });
    await access(second);
    f = await storageFixture(root);
    await f.storage.resume();
    expect(f.storage.status("owner", plan.id)).toMatchObject({
      state: "complete",
      items: [{ state: "removed" }, { state: "removed" }],
    });
    await expect(access(second)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.storage.apply("owner", plan.id, plan.revision)).state).toBe("complete");
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing storage again never closes a descriptor that reused the pinned root's number", async () => {
  const f = await storageFixture();
  const path = join(f.root, "unrelated.txt");
  await writeFile(path, "unrelated");
  await f.storage.close();
  // The lowest free descriptor is the one storage just released.
  const unrelated = await open(path, "r");
  try {
    await f.storage.close();
    expect(await unrelated.readFile("utf8")).toBe("unrelated");
  } finally {
    await unrelated.close();
    await f.close();
  }
});
