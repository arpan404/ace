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

test("an untracked regular path replaced by a FIFO after Git lists it never blocks acquisition", async () => {
  const root = await repository();
  const outside = await scratch();
  const fifo = join(outside, "fifo");
  const victim = join(root, "victim");
  await execute("mkfifo", [fifo]);
  await put(root, "victim", "original\n");
  await put(root, "control", "one\ntwo\n");
  const wrapper = join(outside, "git-wrapper");
  // Run real Git, then change the filesystem after its listing has been captured
  // and before the listing is delivered to the service's acquisition boundary.
  await writeFile(
    wrapper,
    `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
const args = process.argv.slice(2);
const result = spawnSync("git", args, { maxBuffer: 1024 * 1024 });
if (args[0] === "status" && existsSync(${JSON.stringify(fifo)})) renameSync(${JSON.stringify(fifo)}, ${JSON.stringify(victim)});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
`,
    { mode: 0o700 },
  );
  const service = new GitService({ gitBinary: wrapper });
  let release: Promise<unknown> | undefined;
  const watchdog = setTimeout(() => {
    release = open(victim, constants.O_RDWR | constants.O_NONBLOCK).then((handle) =>
      handle.close(),
    );
  }, 60000);
  try {
    const changed = await service.changedFiles(root);
    expect(release, "replacement must not require a FIFO writer to unblock Git").toBeUndefined();
    expect(changed.files).toEqual([
      { path: "control", status: "untracked", additions: 2, deletions: 0, binary: false },
      { path: "victim", status: "untracked", additions: 0, deletions: 0, binary: false },
    ]);
    expect((await service.status(root)).untracked).toContain("victim");
  } finally {
    clearTimeout(watchdog);
    await release;
    await service.close();
  }
});
