import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { HostId, ThreadId } from "@ace/protocol";

/*
 * Threads ace delegated to other machines and worktree starts that stop, for the phone (no
 * provider CLI runs):
 * - `ios-elsewhere`: a root that handed one child to this same machine under its own host id (the
 *   phone has it, so the child opens there) and one to a machine the phone isn't paired with
 *   (it says so instead of opening).
 * - project `setup-script` (`ios-setup-seed`'s): its worktree setup script fails, so a worktree
 *   start there keeps its card with Retry, Continue and Don't use worktree.
 */

const delegated = (child: string, title: string, machine: { name: string; hostId: string }) => ({
  type: "item.upsert" as const,
  agent: "root",
  item: `delegation-${child}`,
  draft: {
    type: "delegation.started" as const,
    origin: "ace" as const,
    childThreadId: ThreadId.parse(child),
    provider: "codex" as const,
    title,
    role: "docs",
    phase: "running" as const,
    status: { state: "working" as const, agents: 1 },
    updatedAt: 1000,
    generation: 0,
    complete: false,
    outcome: null,
    machine: { machine: machine.hostId, name: machine.name, hostId: HostId.parse(machine.hostId) },
  },
});

export function seedElsewhere(daemon: FakeDaemon, machine: { hostId: string; name: string }): void {
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-elsewhere-child",
    workspaceId: "ace",
    title: "Write the relay guide",
    provider: "codex",
  });
  daemon.apply("ios-elsewhere-child", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "guide-ask", "user", "Write the relay guide."),
  ]);
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-elsewhere",
    workspaceId: "ace",
    title: "Docs across machines",
    provider: "codex",
  });
  daemon.apply("ios-elsewhere", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Split the docs across the machines."),
    delegated("ios-elsewhere-child", "Write the relay guide", machine),
    delegated("ios-elsewhere-far", "Check the Linux build", {
      name: "build-box",
      hostId: "ios-spike-unpaired",
    }),
  ]);
}

export function seedWorktreeStops(daemon: FakeDaemon): void {
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-setup-seed",
    workspaceId: "setup-script",
    title: "Set up the setup script",
    provider: "claude",
    details: { workspace: { id: "setup-script", name: "setup-script", path: "/tmp/setup-script" } },
  });
  daemon.apply("ios-setup-seed", [facts.rootAgent("claude")]);
  daemon.workspace.git.failSetup("setup-script", [
    "$ bun install",
    "error: lockfile had changes, but lockfile is frozen",
  ]);
}
