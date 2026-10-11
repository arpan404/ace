import { constants } from "node:fs";
import { open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { execute, put, repository, scratch } from "./test-repo.ts";

test("untracked links never read external bytes or wait for a FIFO writer and release Git serialization", async () => {
  const root = await repository();
  const outside = await scratch();
  const fifo = join(outside, "fifo");
  await execute("mkfifo", [fifo]);
  await writeFile(join(outside, "binary"), Buffer.from([0, 1, 2]));
  await symlink(fifo, join(root, "stream-link"));
  await symlink(join(outside, "binary"), join(root, "external-link"));
  await put(root, "regular", "one\ntwo");
  const service = new GitService();
  let release: Promise<unknown> | undefined;
  const watchdog = setTimeout(() => {
    // Let a broken blocking open unwind so the test can clean up its real repository.
    release = open(fifo, constants.O_RDWR | constants.O_NONBLOCK).then((handle) => handle.close());
  }, 60000);
  try {
    const changed = await service.changedFiles(root);
    expect(release, "status must settle without a FIFO writer").toBeUndefined();
    expect(changed.files).toEqual([
      { path: "external-link", status: "untracked", additions: 0, deletions: 0, binary: false },
      { path: "regular", status: "untracked", additions: 2, deletions: 0, binary: false },
      { path: "stream-link", status: "untracked", additions: 0, deletions: 0, binary: false },
    ]);
    expect((await service.status(root)).untracked).toContain("stream-link");
  } finally {
    clearTimeout(watchdog);
    await release;
    await service.close();
  }
});
