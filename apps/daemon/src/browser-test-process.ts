import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
export async function ownedBrowserPids(home: string): Promise<number[]> {
  const result = await exec("ps", ["-axo", "pid,command"]);
  return z
    .array(z.number().int().positive())
    .max(128)
    .parse(
      result.stdout
        .split("\n")
        .filter((line) => line.includes(`--user-data-dir=${home}`))
        .map((line) => Number(line.trim().split(/\s/, 1)[0])),
    );
}

/** After an abrupt parent exit, observe child process exit through the OS.
 * Each ps completion is an I/O boundary, with no timer or sleep synchronization.
 * A zombie has already exited; OS reaping is outside the daemon's ownership. */
export async function waitForBrowserExit(pids: number[], signal?: AbortSignal): Promise<void> {
  let live = pids;
  while (live.length) {
    signal?.throwIfAborted();
    const output = await new Promise<string>((resolve, reject) => {
      execFile("ps", ["-p", live.join(","), "-o", "pid=,state="], (error, stdout) => {
        if (!error || error.code === 1) resolve(stdout);
        else reject(error);
      });
    });
    live = z
      .array(z.tuple([z.coerce.number().int().positive(), z.string().min(1).max(16)]))
      .max(128)
      .parse(
        output.trim()
          ? output
              .trim()
              .split("\n")
              .map((line) => line.trim().split(/\s+/))
          : [],
      )
      .filter(([, state]) => !state.startsWith("Z"))
      .map(([pid]) => pid);
  }
}
