import {
  discoverListeners,
  processParents,
  systemProcessIo,
  type ProcessIo,
} from "@ace/preview/detection";
import { taskPorts } from "./task-ports.ts";

/*
 * The thin OS shell of the port probe (ADR 0109). macOS asks lsof; Linux reads /proc. Other
 * platforms answer nothing, so their background commands keep holding as before.
 */

const answered = (code: number | null) => code === 0 || code === 1;

/** The processes that have `path` open. */
export async function outputHolders(path: string, io: ProcessIo): Promise<Set<number>> {
  if (io.platform === "darwin") {
    const output = await io.run("lsof", ["-t", "--", path]);
    if (!answered(output.code)) throw new Error("lsof output lookup failed");
    return new Set(
      output.stdout
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    );
  }
  if (io.platform === "linux") {
    const holders = new Set<number>();
    const pids = (await io.list("/proc")).filter((name) => /^\d+$/.test(name));
    for (const pid of pids) {
      // Another user's descriptors are unreadable; those processes are never ours anyway.
      const fds = await io.list(`/proc/${pid}/fd`).catch((): string[] => []);
      for (const fd of fds)
        if ((await io.link(`/proc/${pid}/fd/${fd}`).catch(() => "")) === path) {
          holders.add(Number(pid));
          break;
        }
    }
    return holders;
  }
  return new Set();
}

export type PortProbe = (outputPaths: readonly string[]) => Promise<Map<string, number[]>>;

/** Each command's listening ports, by output file; one listener and process table per call. */
export function systemPortProbe(io: ProcessIo = systemProcessIo): PortProbe {
  return async (outputPaths) => {
    const result = new Map<string, number[]>();
    if (!outputPaths.length || (io.platform !== "darwin" && io.platform !== "linux")) return result;
    const [listeners, parents] = await Promise.all([discoverListeners(io), processParents(io)]);
    for (const path of outputPaths)
      result.set(path, taskPorts(listeners, parents, await outputHolders(path, io)));
    return result;
  };
}
