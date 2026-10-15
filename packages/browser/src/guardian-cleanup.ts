export type ProcessEntry = {
  pid: number;
  group: number;
  state: string;
  command: string;
};

export type ReapInput = {
  profile: string;
  self: number;
  processes: () => Promise<ProcessEntry[]>;
  kill: (group: number) => Promise<void>;
};

// Chromium launches detached. A helper can survive pipe EOF after its browser
// parent dies. Match the exclusive profile again before signaling its live group;
// the remaining helper reserves that group id and prevents PID reuse mistakes.
export async function reapProfileGroups(input: ReapInput): Promise<void> {
  async function ownedGroups(): Promise<Set<number>> {
    const groups = new Set<number>();
    for (const entry of await input.processes()) {
      if (
        entry.state.startsWith("Z") ||
        !(entry.command + " ").includes(` --user-data-dir=${input.profile} `)
      )
        continue;
      if (entry.group === input.self) throw new Error("Chromium guardian cannot own itself");
      groups.add(entry.group);
      if (groups.size > 16) throw new Error("Chromium process group limit");
    }
    return groups;
  }

  const selected = await ownedGroups();
  const confirmed = await ownedGroups();
  const killed = new Set<number>();
  for (const group of selected) {
    if (!confirmed.has(group)) continue;
    try {
      await input.kill(group);
    } catch (error) {
      // macOS reports EPERM, not ESRCH, for a group left with only zombies.
      // The inventory below still fails cleanup if the group stays alive.
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    }
    killed.add(group);
  }
  // Wait for kernel exit before releasing the profile to removal or reopening.
  // Each inventory is an I/O boundary; zombies have already stopped writing.
  for (let attempt = 0; killed.size && attempt < 64; attempt++) {
    const live = (await input.processes()).some(
      (entry) => killed.has(entry.group) && !entry.state.startsWith("Z"),
    );
    if (!live) return;
  }
  if (killed.size) throw new Error("Chromium process group did not exit");
}
