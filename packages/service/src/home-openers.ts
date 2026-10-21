import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Which processes have any of these files open; empty when none do or nobody can tell. */
export type OpenersOf = (files: readonly string[]) => number[];

// Files a running ace keeps open or publishes: databases and their journals, sockets, pid files.
const live = /\.(?:sqlite|sqlite-wal|sqlite-shm|db|db-wal|sock|socket|pid|lock)$/;
// Checkouts can be huge and hold nothing a daemon keeps open.
const skipped = new Set(["worktrees", "node_modules", "releases"]);
const maxFiles = 256;

function entries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The files under `root`, two levels deep, that an older ace would hold open while it runs. ace
 * 0.x keeps no pid or port file (its `~/.ace/daemon` is empty); its server and app hold
 * `userdata/state.sqlite` and its journal open instead.
 */
export function liveFiles(root: string): string[] {
  const files: string[] = [];
  const pending: [string, number][] = [[root, 0]];
  while (pending.length > 0 && files.length < maxFiles) {
    const next = pending.shift();
    if (!next) break;
    const [directory, depth] = next;
    for (const entry of entries(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2 && !skipped.has(entry.name)) pending.push([path, depth + 1]);
      } else if (live.test(entry.name) && files.length < maxFiles) files.push(path);
    }
  }
  return files;
}

/** Pids recorded in `*.pid` files among `files`. */
export function recordedPids(files: readonly string[]): number[] {
  const pids: number[] = [];
  for (const file of files) {
    if (!file.endsWith(".pid")) continue;
    try {
      const pid = Number(readFileSync(file, "utf8").slice(0, 32).trim());
      if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
    } catch {
      // Unreadable or vanished: nothing recorded.
    }
  }
  return pids;
}

const maxProcesses = 16_384;
const maxDescriptors = 65_536;

/**
 * Which processes under `procRoot` (a Linux `/proc`) hold any of `files` open, read from each
 * process's `fd` links. Another user's descriptors are unreadable and skipped: those processes
 * can't be this user's ace. Bounded so a crowded host answers promptly.
 */
export function procOpeners(files: readonly string[], procRoot = "/proc"): number[] {
  if (files.length === 0) return [];
  const wanted = new Set<string>();
  for (const file of files) {
    wanted.add(file);
    try {
      wanted.add(realpathSync(file));
    } catch {
      // Gone already: only the path as given can match.
    }
  }
  const pids: number[] = [];
  let descriptors = 0;
  const processes = entries(procRoot)
    .filter((entry) => /^\d+$/.test(entry.name))
    .slice(0, maxProcesses);
  for (const entry of processes) {
    const directory = join(procRoot, entry.name, "fd");
    for (const fd of entries(directory)) {
      if (++descriptors > maxDescriptors) return pids;
      let target: string;
      try {
        target = readlinkSync(join(directory, fd.name));
      } catch {
        continue;
      }
      if (wanted.has(target)) {
        pids.push(Number(entry.name));
        break;
      }
    }
  }
  return pids;
}

/**
 * `lsof -t` over the files, bounded to five seconds. A host without lsof, or one that times
 * out, reports nobody: the pid and lock checks still apply, and a fresh start never sticks.
 */
function lsofOpeners(files: readonly string[]): number[] {
  if (files.length === 0) return [];
  const result = spawnSync("lsof", ["-t", "--", ...files], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || typeof result.stdout !== "string") return [];
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/** Linux reads `/proc` (lsof is often not installed there); other hosts ask lsof. */
export const systemOpeners: OpenersOf = (files) =>
  process.platform === "linux" ? procOpeners(files) : lsofOpeners(files);
