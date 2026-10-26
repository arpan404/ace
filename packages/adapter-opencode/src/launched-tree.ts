import type { WindowsTreeMember } from "@ace/provider-kit/process-identity";

/** The process ace launched: creation time and owner pin it against PID reuse. */
export type TreeLeader = { pid: number; start: string; uid: string };

/** Native lookups for the process tree ace launched on Windows. Tests inject a fake. */
export type LaunchedTree = {
  /** The launched process's identity, read right after spawn; undefined once it is gone. */
  leader(pid: number): TreeLeader | undefined;
  /** Live members of that launch with their creation times, the leader included. */
  members(leader: TreeLeader): readonly WindowsTreeMember[];
};

/** The real lookups. Imported only on Windows: provider-kit binds kernel32 through koffi. */
export async function nativeLaunchedTree(): Promise<LaunchedTree> {
  const kit = await import("@ace/provider-kit/process-identity");
  return {
    leader(pid) {
      const found = kit.processIdentity(pid);
      return found && { pid, start: found.start, uid: String(found.uid) };
    },
    members: (leader) => kit.windowsTreeRuntime.state([leader]).live,
  };
}
