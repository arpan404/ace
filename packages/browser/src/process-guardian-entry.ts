import { isAbsolute } from "node:path";
import { z } from "zod";
import { chromiumProcessKiller } from "./chromium-process.ts";
import { listProcesses } from "./process-table.ts";

const [profile] = z.tuple([z.string().min(1)]).parse(process.argv.slice(2));
if (!isAbsolute(profile)) throw new Error("Chromium profile must be absolute");
const processes = () => listProcesses(process.platform);

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
    // SIGKILL always completes, but a loaded machine can take longer than any fixed
    // number of inventories, so wait for the exit itself. Only processes still naming
    // this profile count, so a reused group id cannot hold cleanup open.
    // Each inventory is an I/O boundary; zombies have already stopped writing.
    while (killed.size) {
      const live = (await processes()).some(
        (entry) =>
          killed.has(entry.group) &&
          !entry.state.startsWith("Z") &&
          (entry.command + " ").includes(` --user-data-dir=${profile} `),
      );
      if (!live) return;
    }
  })().catch(() => {
    process.exitCode = 1;
  });
});
process.send?.("ready");
