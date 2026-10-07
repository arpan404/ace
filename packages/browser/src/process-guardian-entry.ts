import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { chromiumProcessKiller } from "./chromium-process.ts";

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

// Chromium launches detached. A helper can survive pipe EOF after its browser
// parent dies. Match the exclusive profile again before signaling its live group;
// the remaining helper reserves that group id and prevents PID reuse mistakes.
async function ownedGroups() {
  const groups = new Set<number>();
  for (const entry of await processes()) {
    if (
      entry.state.startsWith("Z") ||
      !(entry.command + " ").includes(` --user-data-dir=${profile} `)
    )
      continue;
    if (entry.group === process.pid) throw new Error("Chromium guardian cannot own itself");
    groups.add(entry.group);
    if (groups.size > 16) throw new Error("Chromium process group limit");
  }
  return groups;
}
process.once("disconnect", () => {
  void (async () => {
    const selected = await ownedGroups();
    const confirmed = await ownedGroups();
    const killed = new Set<number>();
    const kill = chromiumProcessKiller(process.platform);
    for (const group of selected) {
      if (!confirmed.has(group)) continue;
      await kill(group);
      killed.add(group);
    }
    // Wait for kernel exit before releasing the profile to removal or reopening.
    // Each inventory is an I/O boundary; zombies have already stopped writing.
    for (let attempt = 0; killed.size && attempt < 64; attempt++) {
      const live = (await processes()).some(
        (entry) => killed.has(entry.group) && !entry.state.startsWith("Z"),
      );
      if (!live) return;
    }
    if (killed.size) throw new Error("Chromium process group did not exit");
  })().catch(() => {
    process.exitCode = 1;
  });
});
process.send?.("ready");
