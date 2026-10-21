import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

export interface ProcessEntry {
  pid: number;
  group: number;
  /** `Z` for a zombie. */
  state: string;
  command: string;
}
const Entry = z.object({
  pid: z.number().int().nonnegative(),
  group: z.number().int().nonnegative(),
  state: z.string().min(1),
  command: z.string(),
});

/**
 * One process from `/proc/<pid>/stat` and `/proc/<pid>/cmdline`. The command name in `stat` is
 * in parentheses and may itself hold spaces and parentheses, so fields start after the last `)`.
 */
export function procEntry(stat: string, cmdline: string): ProcessEntry | undefined {
  const close = stat.lastIndexOf(")");
  const pid = Number.parseInt(stat, 10);
  if (close < 0 || !Number.isSafeInteger(pid)) return undefined;
  const [state, , group] = stat.slice(close + 2).split(" ");
  const parsed = Entry.safeParse({
    pid,
    group: Number(group),
    state,
    // Arguments are NUL-separated; a process that rewrote its title may use spaces.
    command: cmdline.replace(/\0+$/, "").replaceAll("\0", " "),
  });
  return parsed.success ? parsed.data : undefined;
}

/** Every process on Linux, from `/proc`; works where procps (`ps`) is not installed. */
async function procProcesses(): Promise<ProcessEntry[]> {
  const entries: ProcessEntry[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const [stat, cmdline] = await Promise.all([
        readFile(`/proc/${name}/stat`, "utf8"),
        readFile(`/proc/${name}/cmdline`, "utf8"),
      ]);
      const entry = procEntry(stat, cmdline);
      if (entry) entries.push(entry);
    } catch {
      /* The process exited while it was being read. */
    }
  }
  return entries;
}

const execute = promisify(execFile);
async function psProcesses(): Promise<ProcessEntry[]> {
  const { stdout } = await execute("ps", ["-axo", "pid=,pgid=,state=,command="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return Entry.parse({
        pid: Number(match?.[1]),
        group: Number(match?.[2]),
        state: match?.[3],
        command: match?.[4],
      });
    });
}

/** The machine's processes with their groups and command lines. */
export function listProcesses(platform: NodeJS.Platform): Promise<ProcessEntry[]> {
  return platform === "linux" ? procProcesses() : psProcesses();
}
