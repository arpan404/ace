import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { procOpeners } from "./home-openers.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A `/proc` laid out on disk: each pid's `fd` directory holds links to what it has open. */
async function fakeProc(open: Record<string, readonly string[]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-proc-"));
  roots.push(root);
  await mkdir(join(root, "self"));
  for (const [pid, targets] of Object.entries(open)) {
    await mkdir(join(root, pid, "fd"), { recursive: true });
    for (const [fd, target] of targets.entries())
      await symlink(target, join(root, pid, "fd", String(fd)));
  }
  return root;
}

test("Linux openers are the processes whose descriptors point at the old ace's files", async () => {
  const data = await mkdtemp(join(tmpdir(), "ace-old-data-"));
  roots.push(data);
  const state = join(data, "state.sqlite");
  await writeFile(state, "old state");
  const proc = await fakeProc({
    "101": ["/dev/null", state],
    "202": ["/dev/null", "socket:[1234]"],
    "303": [`${state}-wal`],
  });

  expect(procOpeners([state, join(data, "daemon.pid")], proc)).toEqual([101]);
  expect(procOpeners([], proc)).toEqual([]);
});

test("a missing /proc reports nobody instead of failing", () => {
  expect(procOpeners(["/tmp/x.sqlite"], join(tmpdir(), "ace-no-proc-here"))).toEqual([]);
});
