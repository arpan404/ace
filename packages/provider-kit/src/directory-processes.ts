import { execFile } from "node:child_process";
import { opendir, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const pidSchema = z.coerce.number().int().positive();
function withinLease(cwd: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const path = relative(root, cwd);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  });
}
/** Only for an exclusive, private operation directory, never a user workspace. */
async function directoryPids(
  directories: readonly string[],
  selected?: readonly number[],
): Promise<number[]> {
  const roots = directories.map((directory) => resolvePath(directory));
  if (process.platform === "linux") {
    const result: number[] = [];
    let count = 0;
    if (selected) {
      for (const pid of selected) {
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
        if (cwd && withinLease(cwd, roots)) result.push(pid);
      }
      return result;
    }
    const entries = await opendir("/proc");
    for await (const entry of entries) {
      if (!/^\d+$/.test(entry.name)) continue;
      if (++count > 16384) throw new Error("Process inspection exceeds limit");
      const cwd = await readlink(`/proc/${entry.name}/cwd`).catch(() => undefined);
      if (cwd && withinLease(cwd, roots)) result.push(pidSchema.parse(entry.name));
      if (result.length === 64) break;
    }
    return result;
  }
  const selection = selected ? ["-p", selected.join(",")] : ["-u", String(process.getuid?.())];
  const output = await execute(
    "/usr/sbin/lsof",
    ["-n", "-P", "-a", ...selection, "-d", "cwd", "-F0pn"],
    { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
  ).catch((error: unknown) => {
    if (!z.object({ code: z.literal(1) }).safeParse(error).success) throw error;
    return { stdout: "" };
  });
  const pids: number[] = [];
  let pid: number | undefined;
  let count = 0;
  for (const record of output.stdout.split("\0")) {
    const field = record.replace(/^\n/, "");
    if (field.startsWith("p")) {
      if (++count > 16384) throw new Error("Process inspection exceeds limit");
      pid = pidSchema.parse(field.slice(1));
    } else if (field.startsWith("n") && pid !== undefined && withinLease(field.slice(1), roots)) {
      pids.push(pid);
      if (pids.length === 64) break;
    }
  }
  return pids;
}

function kill(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error;
  }
}
/** Re-check the directory lease before signaling, then wait for kernel termination. */
export async function terminateDirectoryProcesses(directories: readonly string[]): Promise<void> {
  for (let batch = 0; batch < 64; batch++) {
    const selected = (await directoryPids(directories)).filter((pid) => pid !== process.pid);
    if (!selected.length) return;
    const confirmed = new Set(await directoryPids(directories, selected));
    const pids = selected.filter((pid) => confirmed.has(pid));
    for (const pid of pids) kill(pid);
    if (!pids.length) return;
    // ps reports zombie state without waiting indefinitely for the OS orphan reaper.
    for (let attempt = 0; attempt < 64; attempt++) {
      const output = await execute("ps", ["-p", pids.join(","), "-o", "stat="], {
        maxBuffer: 8192,
        timeout: 5000,
      }).catch((error: unknown) => {
        if (!z.object({ code: z.literal(1) }).safeParse(error).success) throw error;
        return { stdout: "" };
      });
      if (output.stdout.split("\n").every((state) => !state.trim() || state.trim().startsWith("Z")))
        break;
      if (attempt === 63) throw new Error("Owned processes did not terminate");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new Error("Owned process limit");
}
