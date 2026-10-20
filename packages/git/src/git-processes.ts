import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { within } from "./repository-paths.ts";

/** A live Git process on this machine and the directory it runs in. */
export interface GitProcess {
  pid: number;
  /** Absent when the process can't be inspected: it may be working anywhere. */
  cwd?: string | undefined;
  /** The checkout `cwd` belongs to: the nearest directory with a `.git` entry. */
  checkout?: string | undefined;
}
/**
 * Every live Git process, or `undefined` when this platform can't list them. Callers treat
 * `undefined` as "a writer may be running", so missing evidence never retires anything.
 */
export type GitProcessScan = () => Promise<readonly GitProcess[] | undefined>;

/**
 * PIDs of the Git processes this daemon is running right now and still owns. Their own scheduling
 * locks already order them, so they never count as someone else's writer. A killed process leaves
 * this set at once: until its group is gone it is evidence that a writer may survive.
 */
export const runningChildren = new Set<number>();

/**
 * Whether `process` works in any of `roots`, or is a clone creating one of them. Git in a
 * checkout nested inside a root (an agent's linked worktree, say) works in that checkout only.
 */
export function touches(process: GitProcess, roots: readonly string[]): boolean {
  const { cwd, checkout } = process;
  if (cwd === undefined) return true;
  return roots.some(
    (root) =>
      cwd === dirname(root) || (checkout === undefined ? within(root, cwd) : checkout === root),
  );
}

async function checkoutOf(cwd: string): Promise<string | undefined> {
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (
      await lstat(join(directory, ".git")).then(
        () => true,
        () => false,
      )
    )
      return directory;
    if (dirname(directory) === directory) return;
  }
}

/** Whether any process of the POSIX process group led by `pid` is still alive. */
export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process exists there, even if it isn't ours to signal.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

// `git fsmonitor--daemon` lives as long as the checkout does; it never holds a mutation open.
const longLived = (command: string) => command.includes("fsmonitor--daemon");

function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    // One output format whatever locale the daemon inherited: lsof escapes non-ASCII as bytes.
    const env = { ...process.env, LC_ALL: "C" };
    execFile(command, args, { timeout: 5000, maxBuffer: 4_194_304, env }, (error, stdout) => {
      // lsof exits 1 with no output when nothing matches.
      if (error && !(typeof error.code === "number" && error.code === 1 && stdout === ""))
        resolve(undefined);
      else resolve(stdout);
    });
  });
}

const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "\\": "\\" };
/**
 * lsof writes a backslash as `\\` and control bytes as `\n`, `\t`, `\xNN` or `^X`. Without a
 * UTF-8 locale (a daemon launchd started) it also writes each byte of a non-ASCII name as `\xNN`,
 * so the bytes are collected and decoded as UTF-8. Anything else can't be compared, so the
 * process may be working anywhere.
 */
function lsofName(name: string): string | undefined {
  if (/\^[@A-Z[\\\]^_?]/.test(name)) return;
  const bytes: number[] = [];
  // By code point, so a character lsof left as it is keeps its whole encoding.
  const characters = Array.from(name);
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
    if (character !== "\\") {
      bytes.push(...utf8Bytes.encode(character));
      continue;
    }
    const next = characters[index + 1] ?? "";
    const hex = /^x([0-9a-fA-F]{2})/.exec(characters.slice(index + 1, index + 4).join(""));
    const escaped = escapes[next];
    if (hex?.[1]) {
      bytes.push(Number.parseInt(hex[1], 16));
      index += 3;
    } else if (escaped !== undefined) {
      bytes.push(...utf8Bytes.encode(escaped));
      index += 1;
    } else return;
  }
  try {
    return utf8.decode(Uint8Array.from(bytes));
  } catch {
    return;
  }
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf8Bytes = new TextEncoder();

async function darwin(): Promise<GitProcess[] | undefined> {
  const listing = await run("lsof", ["-nP", "-w", "-a", "-c", "git", "-d", "cwd", "-F", "pn"]);
  if (listing === undefined) return;
  const found: GitProcess[] = [];
  let pid: number | undefined;
  for (const line of listing.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid && Number.isSafeInteger(pid)) {
      found.push({ pid, cwd: lsofName(line.slice(1)) });
    }
  }
  if (!found.length) return found;
  const commands = await run("ps", ["-o", "pid=,args=", "-p", found.map((p) => p.pid).join(",")]);
  if (commands === undefined) return found;
  const skipped = new Set<number>();
  for (const line of commands.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined && longLived(match[2])) skipped.add(Number(match[1]));
  }
  return found.filter((entry) => !skipped.has(entry.pid));
}

async function linux(): Promise<GitProcess[] | undefined> {
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return;
  }
  const found: GitProcess[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const command = await readFile(`/proc/${name}/comm`, "utf8").catch(() => "");
    if (!command.trim().startsWith("git")) continue; // Not Git, or already exited.
    const args = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    if (longLived(args.replaceAll("\0", " "))) continue;
    // A Git process whose cwd we can't read may be working anywhere.
    const cwd = await readlink(`/proc/${name}/cwd`).catch(() => undefined);
    found.push({ pid: Number(name), cwd });
  }
  return found;
}

/** The platform's process listing, without this daemon's own running Git children. */
export function scanGitProcesses(platform: NodeJS.Platform): GitProcessScan {
  const list = platform === "darwin" ? darwin : platform === "linux" ? linux : undefined;
  return async () => {
    const found = await list?.();
    if (!found) return;
    const others = found.filter((entry) => !runningChildren.has(entry.pid));
    for (const entry of others)
      if (entry.cwd !== undefined) entry.checkout = await checkoutOf(entry.cwd);
    return others;
  };
}
