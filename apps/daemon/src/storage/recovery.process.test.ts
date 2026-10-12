import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { storageFixture } from "./test-support.ts";

test("a daemon crash after removing bytes resumes the durable plan without repeating other effects", async () => {
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
