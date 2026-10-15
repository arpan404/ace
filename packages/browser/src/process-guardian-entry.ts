import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { chromiumProcessKiller } from "./chromium-process.ts";
import { reapProfileGroups } from "./guardian-cleanup.ts";

const [profile] = z.tuple([z.string().min(1)]).parse(process.argv.slice(2));
if (!isAbsolute(profile)) throw new Error("Chromium profile must be absolute");
const execute = promisify(execFile);
const Process = z.object({
  pid: z.number().int().nonnegative(),
  group: z.number().int().nonnegative(),
  state: z.string().min(1),
  command: z.string(),
});
async function processes() {
  const { stdout } = await execute("ps", ["-axo", "pid=,pgid=,state=,command="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return Process.parse({
        pid: Number(match?.[1]),
        group: Number(match?.[2]),
        state: match?.[3],
        command: match?.[4],
      });
    });
}

process.once("disconnect", () => {
  void (async () => {
    await reapProfileGroups({
      profile,
      self: process.pid,
      processes,
      kill: chromiumProcessKiller(process.platform),
    });
  })().catch(() => {
    process.exitCode = 1;
  });
});
process.send?.("ready");
