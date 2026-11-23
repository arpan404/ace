// SPDX-License-Identifier: Apache-2.0

/*
 * The write-digest gate (ADR 0224 §7): runs one test file with the git parts
 * off and on, and fails unless the two `ACE_GIT_DIGEST_LOG` logs are
 * identical. The shell appends, for every checkpoint, commit, merge commit,
 * restore and worktree write, the operation, its order in the test, and
 * result-derived identity; G4 and G5 extend the entries with the trees the
 * gate then requires identical.
 *
 *   ACE_STORE=native ACE_SUPERVISOR=native ACE_GIT=<parts> bun scripts/native-git-digest.ts <file>
 *
 * `<parts>` is the on-run's value (with the parts off the shell logs the
 * same shape through the TypeScript path, since the log holds no backend).
 * Each run gets a fresh digest log. A write part ships only when every file
 * of its proof list passes this.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const [file] = process.argv.slice(2);
if (file === undefined) throw new Error("usage: bun scripts/native-git-digest.ts <test-file>");
if (!existsSync(resolve(root, file)) && !existsSync(file))
  throw new Error(`No such test file: ${file}; an empty path would run the whole suite`);
const parts = process.env.ACE_GIT;
if (!parts) throw new Error("Set ACE_GIT to the on-run's parts in this environment first");

function digestOf(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

const digests: Record<string, string[]> = {};
for (const off of [false, true]) {
  const label = off ? "parts off" : "parts on";
  const dir = mkdtempSync(join(tmpdir(), "ace-native-git-digest-"));
  const log = join(dir, "digest.jsonl");
  try {
    const env = { ...process.env, ACE_GIT_DIGEST_LOG: log };
    // Neither run alternates: the digest compares backends, not orders.
    delete env.ACE_NATIVE_CROSS;
    delete env.ACE_GIT_CROSS_START;
    delete env.ACE_GIT_OP_LOG;
    if (off) delete env.ACE_GIT;
    const run = spawnSync("bun", ["--bun", "x", "vitest", "run", file, "--maxWorkers=4"], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    if (run.error) throw run.error;
    if (run.status !== 0) process.exit(run.status ?? 1);
    digests[label] = digestOf(log);
    console.log(`${label}: ${digests[label]?.length ?? 0} write(s) logged`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const off = digests["parts off"] ?? [];
const on = digests["parts on"] ?? [];
if (off.length !== on.length || off.some((line, index) => line !== on[index])) {
  const lines = Math.max(off.length, on.length);
  for (let index = 0; index < lines; index++) {
    if (off[index] !== on[index])
      console.error(
        `entry ${index}:\n  off: ${off[index] ?? "(missing)"}\n  on:  ${on[index] ?? "(missing)"}`,
      );
  }
  throw new Error(
    `digest mismatch: ${off.length} write(s) with parts off, ${on.length} with parts on`,
  );
}
console.log(`digests identical: ${on.length} write(s)`);
