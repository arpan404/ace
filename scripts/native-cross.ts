// SPDX-License-Identifier: Apache-2.0

/*
 * The cross-mode gate (porting guide rule 15, ADR 0223 §8): running a file
 * with the switch on and then off never tests rollback, so this runs it
 * twice through the boot log and asserts the alternation from the log.
 *
 *   ACE_STORE=native bun scripts/native-cross.ts ACE_ENGINE <file>
 *
 * The switch's starting-on value comes from this environment (set
 * `ACE_TRANSLATORS=pi`, `ACE_ENGINE=native`, … before calling); the
 * starting-off run unsets it. Each run gets a fresh `ACE_NATIVE_CROSS_LOG`;
 * after a green run this asserts, per run, that every root (event database
 * or process journal) that booted more than once alternated backends from
 * its first boot, and that some root booted twice. A file that never reboots
 * a root fails as "no restart" and leaves its list.
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
];

const [name, file] = process.argv.slice(2);
if (name === undefined || file === undefined || !known.includes(name))
  throw new Error(`usage: bun scripts/native-cross.ts <${known.join("|")}> <test-file>`);
if (!existsSync(resolve(root, file)) && !existsSync(file))
  throw new Error(`No such test file: ${file}; an empty path would run the whole suite`);
if (!process.env[name])
  throw new Error(`Set ${name} to its starting-on value in this environment first`);
if (
  (name === "ACE_SUPERVISOR" || name === "ACE_SESSIONS" || name === "ACE_ENGINE") &&
  process.env.ACE_STORE !== "native"
)
  throw new Error(`${name} needs ACE_STORE=native`);

type BootLine = { root: string; n: number; switch: string; backend: string; pid: number };

function bootsOf(log: string): BootLine[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BootLine);
}

/** Every rebooted root alternated from its first boot, and some root rebooted. */
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
    for (let i = 0; i < boots.length; i++) {
      const boot = boots[i] as BootLine;
      if (boot.n !== i || boot.switch !== name)
        throw new Error(`${label}: ${rootPath} boot ${i} logged as ${JSON.stringify(boot)}`);
      const first = (boots[0] as BootLine).backend;
      if ((boot.backend === first) !== (i % 2 === 0))
        throw new Error(
          `${label}: ${rootPath} did not alternate from ${first}: boot ${i} is ${boot.backend}`,
        );
    }
  }
  if (rebooted === 0) throw new Error(`${label}: no restart: no root booted twice (log ${log})`);
  console.log(`${label}: ${rebooted} rebooted root(s) alternated`);
}

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
