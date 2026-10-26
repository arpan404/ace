import { probeOutput } from "@ace/provider-kit/process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pinnedGitMarker } from "./pinned-process.ts";
import { within } from "./repository-paths.ts";

/** A live Git process on this machine and the directory it runs in. */
export interface GitProcess {
  pid: number;
  /** Absent when the process can't be inspected: it may be working anywhere. */
  cwd?: string | undefined;
  /** The checkout `cwd` belongs to: the nearest directory with a `.git` entry. */
  checkout?: string | undefined;
  /**
   * When the process started, in epoch milliseconds, rounded down so it is never later than the
   * real start. Absent when unknown: the process may then be older than anything it touches.
   */
  startedAt?: number | undefined;
  /**
   * Whether its process group is led by a Git process, as every Git call ace starts is. `false`:
   * a live program other than Git leads it (an agent's shell, say). Absent when unknown, as when
   * the leader has exited.
   */
  gitGroup?: boolean | undefined;
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

/** Spawned from the probe worker: a spawn under load must not hold the daemon's event loop. */
async function run(command: string, args: string[]): Promise<string | undefined> {
  try {
    // One output format whatever locale the daemon inherited: lsof escapes non-ASCII as bytes.
    const { stdout, code } = await probeOutput(command, args, {
      env: { LC_ALL: "C" },
      timeoutMs: 5000,
      maxBytes: 4_194_304,
    });
    // lsof exits 1 with no output when nothing matches.
    return code === 0 || (code === 1 && stdout === "") ? stdout : undefined;
  } catch {
    return undefined;
  }
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
  const commands = await run("ps", [
    "-o",
    "pid=,pgid=,stat=,lstart=,args=",
    "-p",
    found.map((p) => p.pid).join(","),
  ]);
  if (commands === undefined) return found;
  const skipped = new Set<number>();
  const facts = new Map<number, { startedAt: number | undefined; group: number }>();
  for (const line of commands.split("\n")) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s?(.*)$/.exec(line);
    if (!match?.[1] || !match[2] || match[3] === undefined || match[4] === undefined) continue;
    const listed = Number(match[1]);
    // A zombie has exited: it holds nothing.
    if (match[3].startsWith("Z") || longLived(match[5] ?? "")) skipped.add(listed);
    facts.set(listed, { startedAt: psStart(match[4]), group: Number(match[2]) });
  }
  const groups = await darwinGitGroups([...new Set([...facts.values()].map((f) => f.group))]);
  const alive = found.filter((entry) => !skipped.has(entry.pid));
  for (const entry of alive) {
    const fact = facts.get(entry.pid);
    entry.startedAt = fact?.startedAt;
    entry.gitGroup = fact && groups.get(fact.group);
  }
  return alive;
}

const gitCommand = (name: string) => name.startsWith("git");

/**
 * For each process group leader that is alive: whether it is Git, or the helper ace's pinned Git
 * runs under. Leaders that exited or can't be inspected are left out.
 */
async function darwinGitGroups(leaders: readonly number[]): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (!leaders.length) return result;
  // `comm` is the executable's path, whatever the process calls itself.
  const listed = await run("ps", ["-o", "pid=,stat=,comm=", "-p", leaders.join(",")]);
  for (const line of listed?.split("\n") ?? []) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    // An exited leader says nothing about who its group works for.
    if (!match?.[1] || match[3] === undefined || match[2]?.startsWith("Z")) continue;
    result.set(Number(match[1]), gitCommand(basename(match[3].trim())));
  }
  const others = [...result].flatMap(([pid, git]) => (git ? [] : [pid]));
  if (!others.length) return result;
  const helpers = await run("ps", ["-ww", "-o", "pid=,args=", "-p", others.join(",")]);
  if (helpers === undefined) for (const pid of others) result.delete(pid);
  for (const line of helpers?.split("\n") ?? []) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] && match[2]?.includes(` ${pinnedGitMarker} `))
      result.set(Number(match[1]), true);
  }
  return result;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `ps -o lstart` in the C locale, local time, whole seconds: "Sat Oct 24 20:34:00 2026". */
function psStart(text: string): number | undefined {
  const match = /^\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(text.trim());
  if (!match) return;
  const month = months.indexOf(match[1] ?? "");
  if (month < 0) return;
  const [day, hour, minute, second, year] = match.slice(2).map(Number);
  if ([day, hour, minute, second, year].some((part) => part === undefined)) return;
  const at = new Date(year ?? 0, month, day, hour, minute, second).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/** Boot time from `/proc/stat`, in epoch milliseconds. */
async function bootTime(): Promise<number | undefined> {
  const stat = await readFile("/proc/stat", "utf8").catch(() => "");
  const seconds = /^btime (\d+)$/m.exec(stat)?.[1];
  return seconds === undefined ? undefined : Number(seconds) * 1000;
}

/**
 * State and start of a Linux process from `/proc/<pid>/stat`. The start is boot time plus the
 * kernel's start tick (USER_HZ, 100 on every Linux ace runs on), less a second for `btime`'s
 * whole-second rounding.
 */
function linuxStat(stat: string, boot: number | undefined) {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  const startedAt =
    boot !== undefined && Number.isSafeInteger(ticks) ? boot + ticks * 10 - 1000 : undefined;
  const group = Number(fields[2]);
  return { zombie: fields[0] === "Z", startedAt, group: Number.isSafeInteger(group) ? group : 0 };
}

async function linuxGitGroup(group: number): Promise<boolean | undefined> {
  const leader = await readFile(`/proc/${group}/comm`, "utf8").catch(() => "");
  if (!leader) return;
  if (gitCommand(leader.trim())) return true;
  const args = await readFile(`/proc/${group}/cmdline`, "utf8").catch(() => undefined);
  if (args === undefined || args.split("\0").includes(pinnedGitMarker)) return;
  return false;
}

async function linux(): Promise<GitProcess[] | undefined> {
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return;
  }
  const found: GitProcess[] = [];
  const boot = await bootTime();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const command = await readFile(`/proc/${name}/comm`, "utf8").catch(() => "");
    if (!gitCommand(command.trim())) continue; // Not Git, or already exited.
    const args = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    if (longLived(args.replaceAll("\0", " "))) continue;
    const stat = await readFile(`/proc/${name}/stat`, "utf8").catch(() => "");
    const { zombie, startedAt, group } = linuxStat(stat, boot);
    if (zombie) continue;
    // A Git process whose cwd we can't read may be working anywhere.
    const cwd = await readlink(`/proc/${name}/cwd`).catch(() => undefined);
    const gitGroup = group ? await linuxGitGroup(group) : undefined;
    found.push({ pid: Number(name), cwd, startedAt, gitGroup });
  }
  return found;
}

/** The platform's process listing, without this daemon's own running Git children. */
export function scanGitProcesses(platform: NodeJS.Platform): GitProcessScan {
  if (platform === "win32") return scanWindowsGitProcesses();
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

/**
 * Windows: every live Git for Windows process (`git.exe` and its `git-*.exe` helpers) from the
 * system's own `tasklist`. Their working directories aren't listed, so each may be working
 * anywhere and keeps any lease or lock it could hold in place.
 */
/** Windows creation time (100 ns ticks since 1601) in epoch milliseconds, rounded down. */
async function windowsStart(pid: number): Promise<number | undefined> {
  try {
    const { processIdentity } = await import("@ace/provider-kit/process-identity");
    const start = processIdentity(pid)?.start;
    if (start === undefined || !/^\d+$/.test(start)) return;
    return Number(BigInt(start) / 10_000n - 11_644_473_600_000n);
  } catch {
    return undefined;
  }
}

function scanWindowsGitProcesses(): GitProcessScan {
  return async () => {
    const tasklist = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
    const output = await run(tasklist, ["/FI", "IMAGENAME eq git*", "/FO", "CSV", "/NH"]);
    if (output === undefined) return;
    const found: GitProcess[] = [];
    for (const line of output.split(/\r?\n/)) {
      // "git.exe","1234","Console","1","10,000 K"; with no match, an INFO line instead.
      const match = /^"([^"]*)","(\d+)"/.exec(line);
      if (!match?.[2] || !/^git[^\\/]*\.exe$/i.test(match[1] ?? "")) continue;
      const pid = Number(match[2]);
      if (!runningChildren.has(pid)) found.push({ pid, startedAt: await windowsStart(pid) });
    }
    return windowsGitFacts(found);
  };
}

/**
 * Each listed Git's working directory and checkout, as lsof and /proc give them elsewhere, and
 * without the long-lived fsmonitor daemon. A process Windows won't describe keeps no `cwd`.
 */
async function windowsGitFacts(found: GitProcess[]): Promise<GitProcess[]> {
  if (!found.length) return found;
  const { gitProcessFacts } = await import("./git-process-facts.ts");
  const { realpath } = await import("node:fs/promises");
  const facts = gitProcessFacts(found.map((entry) => entry.pid));
  const kept: GitProcess[] = [];
  for (const entry of found) {
    const fact = facts.get(entry.pid);
    if (fact?.commandLine !== undefined && longLived(fact.commandLine)) continue;
    const cwd = fact?.cwd;
    if (cwd !== undefined) {
      // The same canonical form lease roots and lock paths are compared in.
      entry.cwd = await realpath(cwd).catch(() => cwd);
      entry.checkout = await checkoutOf(entry.cwd);
    }
    kept.push(entry);
  }
  return kept;
}
