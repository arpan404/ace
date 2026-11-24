// SPDX-License-Identifier: Apache-2.0

/*
 * The cross-mode gate (porting guide rule 15, ADR 0223 §8): running a file
 * with the switch on and then off never tests rollback, so this runs it
 * twice through the boot log and asserts the alternation from the log.
 *
 *   ACE_STORE=native bun scripts/native-cross.ts ACE_ENGINE <file>
 *
 * `ACE_NATIVE_CROSS=ACE_GIT` instead alternates the backend per git call
 * inside one process (both start orders: `ACE_GIT_CROSS_START`), asserted
 * from the per-operation log at `ACE_GIT_OP_LOG`, since `GitService`
 * instances boot no root: `ACE_GIT=<parts> bun scripts/native-cross.ts
 * ACE_GIT <file>`. A fallback the owning work item didn't list fails the run:
 * G0's `unimplemented` stub and G1's reasons (`reftable`, `replace`, `grafts`,
 * `shallow`, `too_many_refs`, `ambiguous_refs`, `worktree_reason`, `unreadable`,
 * `cancelled`,
 * `directory_fd`, `injected`). Each item adds the reasons it may produce.
 *
 * The switch's starting-on value comes from this environment (set
 * `ACE_TRANSLATORS=pi`, `ACE_ENGINE=native`, … before calling); the
 * starting-off run unsets it. Each run gets a fresh `ACE_NATIVE_CROSS_LOG`;
 * after a green run this asserts, per run, that every root (event database
 * or process journal) that booted more than once alternated the backend it
 * actually ran from its first boot, and that some root booted twice. The log
 * records the effective backend, not the boot's requested one: `ACE_STORE`,
 * `ACE_SUPERVISOR` and `ACE_STORE_WRITER` fix their value at a process's
 * first boot, so a file that reopens the same root in one process runs one
 * backend twice. That file fails as "reopens in-process" instead of passing
 * on a log whose requested values merely alternated. A file that never
 * reboots a root fails as "no restart" and leaves its list.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const known = [
  "ACE_STORE",
  "ACE_TRANSLATORS",
  "ACE_SESSIONS",
  "ACE_SUPERVISOR",
  "ACE_CORE",
  "ACE_ENGINE",
  "ACE_GIT",
  "ACE_STORE_WRITER",
];

/** Switches whose value a process fixes at its first boot; a reopen cannot change it. */
const processFixed = new Set(["ACE_STORE", "ACE_SUPERVISOR", "ACE_STORE_WRITER"]);

const [name, file] = process.argv.slice(2);
if (name === undefined || file === undefined || !known.includes(name))
  throw new Error(`usage: bun scripts/native-cross.ts <${known.join("|")}> <test-file>`);
if (!existsSync(resolve(root, file)) && !existsSync(file))
  throw new Error(`No such test file: ${file}; an empty path would run the whole suite`);
if (!process.env[name])
  throw new Error(`Set ${name} to its starting-on value in this environment first`);
if (
  (name === "ACE_SUPERVISOR" ||
    name === "ACE_SESSIONS" ||
    name === "ACE_ENGINE" ||
    name === "ACE_STORE_WRITER") &&
  process.env.ACE_STORE !== "native"
)
  throw new Error(`${name} needs ACE_STORE=native`);

type BootLine = {
  root: string;
  n: number;
  switch: string;
  backend: string;
  effective: string;
  pid: number;
};

type GitOpLine = {
  seq: number;
  op: string;
  part: string;
  selected: "native" | "typescript";
  completed: "native" | "typescript";
  fallback?: string | undefined;
  pid: number;
};

function linesOf<T>(log: string): T[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function bootsOf(log: string): BootLine[] {
  return linesOf<BootLine>(log);
}

function gitOpsOf(log: string): GitOpLine[] {
  return linesOf<GitOpLine>(log).toSorted((a, b) => a.seq - b.seq);
}

/** Every rebooted root alternated what it ran from its first boot, and some root rebooted. */
function assertAlternation(log: string, label: string): void {
  const byRoot = new Map<string, BootLine[]>();
  for (const line of bootsOf(log)) {
    const boots = byRoot.get(line.root) ?? [];
    boots.push(line);
    byRoot.set(line.root, boots);
  }
  let rebooted = 0;
  for (const [rootPath, boots] of byRoot) {
    if (boots.length < 2) continue;
    rebooted++;
    const first = (boots[0] as BootLine).effective;
    for (let i = 0; i < boots.length; i++) {
      const boot = boots[i] as BootLine;
      if (boot.n !== i || boot.switch !== name)
        throw new Error(`${label}: ${rootPath} boot ${i} logged as ${JSON.stringify(boot)}`);
      // The effective value is what an open after this boot actually runs, so
      // this is the assertion that cannot be fooled by a reopen in one process.
      if ((boot.effective === first) === (i % 2 === 0)) continue;
      const previous = boots[i - 1];
      if (processFixed.has(name) && previous !== undefined && previous.pid === boot.pid)
        throw new Error(
          `${label}: ${rootPath} reopens in-process; the switch is per process, so this file can't prove cross-mode`,
        );
      throw new Error(
        `${label}: ${rootPath} did not alternate from ${first}: boot ${i} ran ${boot.effective} (asked ${boot.backend}, pid ${boot.pid})`,
      );
    }
  }
  if (rebooted === 0) throw new Error(`${label}: no restart: no root booted twice (log ${log})`);
  console.log(`${label}: ${rebooted} rebooted root(s) alternated`);
}

/**
 * Fallback reasons a git part may record: G0's stub deferral and the reasons
 * G1 lists in docs/git/porting-guide.md. A new item adds its own here, so a
 * native selection never passes by silently running the CLI for a reason no
 * work item owns.
 */
const listedFallbacks = new Set([
  "unimplemented",
  "reftable",
  "replace",
  "grafts",
  "shallow",
  "too_many_refs",
  "ambiguous_refs",
  "worktree_reason",
  "unreadable",
  "cancelled",
  "directory_fd",
  "injected",
]);

/**
 * Every selected git call alternated from the run's starting backend, and
 * some call ran on each backend. A fallback outside the listed reasons fails.
 */
function assertGitAlternation(log: string, label: string, start: "native" | "typescript"): void {
  const ops = gitOpsOf(log);
  for (const [index, op] of ops.entries()) {
    if (op.seq !== index)
      throw new Error(`${label}: call ${index} logged as ${JSON.stringify(op)}`);
    const expected = index % 2 === 0 ? start : start === "native" ? "typescript" : "native";
    if (op.selected !== expected)
      throw new Error(
        `${label}: call ${index} (${op.op}) selected ${op.selected}, not alternating from ${start}`,
      );
    if (op.fallback !== undefined && !listedFallbacks.has(op.fallback))
      throw new Error(`${label}: call ${index} (${op.op}) fell back unlisted: ${op.fallback}`);
  }
  const selected = new Set(ops.map((op) => op.selected));
  if (!selected.has("native") || !selected.has("typescript"))
    throw new Error(
      `${label}: no alternation: ${ops.length} dispatched call(s), backends ${[...selected].join(",") || "none"} (log ${log})`,
    );
  console.log(`${label}: ${ops.length} dispatched call(s) alternated from ${start}`);
}

if (name === "ACE_GIT") {
  // Git alternates the backend per call inside one process, both start
  // orders, through one fresh op log per run. `ACE_GIT` stays set: only the
  // starting backend flips.
  const parts = (process.env.ACE_GIT ?? "").split(",").map((part) => part.trim());
  if (
    parts.some((part) => part !== "" && part !== "refs") &&
    process.env.ACE_SUPERVISOR !== "native"
  )
    throw new Error("ACE_NATIVE_CROSS=ACE_GIT with parts past refs needs ACE_SUPERVISOR=native");
  for (const start of ["native", "typescript"] as const) {
    const label = `starting ${start}`;
    const dir = mkdtempSync(join(tmpdir(), "ace-native-cross-"));
    const log = join(dir, "ops.jsonl");
    try {
      const env = {
        ...process.env,
        ACE_NATIVE_CROSS: name,
        // Git boots no root, so no boot log is asserted; the switch module
        // still requires the variable, and workers read it through the
        // test-home allowlist.
        ACE_NATIVE_CROSS_LOG: join(dir, "boots.jsonl"),
        ACE_GIT_CROSS_START: start,
        ACE_GIT_OP_LOG: log,
      };
      const run = spawnSync("bun", ["--bun", "x", "vitest", "run", file, "--maxWorkers=4"], {
        cwd: root,
        env,
        stdio: "inherit",
      });
      if (run.error) throw run.error;
      if (run.status !== 0) process.exit(run.status ?? 1);
      assertGitAlternation(log, label, start);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} else {
  for (const off of [false, true]) {
    const label = off ? "starting off" : "starting on";
    const dir = mkdtempSync(join(tmpdir(), "ace-native-cross-"));
    const log = join(dir, "boots.jsonl");
    try {
      const env = { ...process.env, ACE_NATIVE_CROSS: name, ACE_NATIVE_CROSS_LOG: log };
      if (off) delete env[name];
      const run = spawnSync("bun", ["--bun", "x", "vitest", "run", file, "--maxWorkers=4"], {
        cwd: root,
        env,
        stdio: "inherit",
      });
      if (run.error) throw run.error;
      if (run.status !== 0) process.exit(run.status ?? 1);
      assertAlternation(log, label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
