import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/*
 * Containment of a member's processes on an org host (ADR 0209 §7.3), so stopping their work
 * reaches every descendant, also one that left its process group (`setsid`, a double fork).
 *
 * Linux: each member's processes are moved into a transient systemd scope of their own, made
 * through the user's systemd manager with no delegation, so nothing in it is handed a cgroup
 * subtree to manage. Stopping kills the scope's cgroup at once (`cgroup.kill`), which takes
 * every process in it. The scope lives in the host user's systemd tree, which that user can
 * write: a process that sets out to leave it can, which is phase 1's trusted-member boundary
 * (§1); the separate OS users of phase 2 close it.
 *
 * Elsewhere (macOS in phase 1) it is best effort: each contained process leads its own group
 * (provider-kit spawns them so), and stopping kills those groups. A process that leaves its
 * group outlives it there. The host page says so (§7.3).
 */

export interface Containment {
  readonly kind: "cgroup" | "process-group";
  /** Moves `pid` and what it starts from now on into `account`'s containment; false if it can't. */
  contain(account: string, pid: number): Promise<boolean>;
  /** Kills everything in `account`'s containment and waits, briefly, for it to be gone. */
  kill(account: string): Promise<void>;
}

/** Runs a command; its exit code and output. Injected so a test can stand in for systemd. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs commands with `env`: the daemon's own, which reaches the user's systemd manager. */
export function commandRunner(env: NodeJS.ProcessEnv = process.env): CommandRunner {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(command, [...args], { timeout: 10_000, env }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

const settleMs = 5_000;
const pollMs = 20;

/**
 * Process groups: what each member's contained processes lead, killed together. Best effort:
 * a process that left its group isn't reached.
 */
export function processGroupContainment(
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): Containment {
  const groups = new Map<string, Set<number>>();
  return {
    kind: "process-group",
    async contain(account, pid) {
      const held = groups.get(account) ?? new Set<number>();
      held.add(pid);
      groups.set(account, held);
      return true;
    },
    async kill(account) {
      for (const pid of groups.get(account) ?? []) {
        for (const target of [-pid, pid])
          try {
            kill(target, "SIGKILL");
          } catch {
            // Gone already.
          }
      }
      groups.delete(account);
    },
  };
}

/** The scope a member's processes run in, distinct per daemon home so two hosts never share one. */
export function memberScope(instance: string, account: string): string {
  const tag = createHash("sha256").update(instance).update("\0").update(account).digest("hex");
  return `ace-member-${tag.slice(0, 24)}.scope`;
}

/** Whether `pid` runs in `unit`, waiting briefly for systemd to move it. */
async function inScope(pid: number, unit: string): Promise<boolean> {
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => undefined);
    if (cgroup === undefined) return false;
    if (cgroup.split("\n").some((line) => line.endsWith(`/${unit}`))) return true;
    await delay(pollMs);
  }
  return false;
}

const systemd = ["org.freedesktop.systemd1", "/org/freedesktop/systemd1"] as const;
const manager = "org.freedesktop.systemd1.Manager";

/**
 * A systemd scope per member, through the user's manager. `instance` names this daemon's home.
 * A process that can't be moved (no user manager, a call refused) is still held by its process
 * group, so stopping reaches at least what the best effort does.
 */
export function systemdScopeContainment(options: {
  instance: string;
  run?: CommandRunner;
  /** Where cgroup v2 is mounted. */
  cgroupRoot?: string;
}): Containment {
  const run = options.run ?? commandRunner();
  const root = options.cgroupRoot ?? "/sys/fs/cgroup";
  const fallback = processGroupContainment();

  async function controlGroup(unit: string): Promise<string | undefined> {
    const shown = await run("systemctl", [
      "--user",
      "show",
      "--property=ControlGroup",
      "--value",
      unit,
    ]);
    const path = shown.stdout.trim();
    return shown.code === 0 && path.startsWith("/") ? path : undefined;
  }

  async function empty(path: string): Promise<boolean> {
    const procs = await readFile(`${root}${path}/cgroup.procs`, "utf8").catch(() => "");
    return procs.trim() === "";
  }

  return {
    kind: "cgroup",
    async contain(account, pid) {
      const unit = memberScope(options.instance, account);
      await fallback.contain(account, pid);
      // A new scope adopting `pid`, or, while the member's scope runs, `pid` joining it.
      const started = await run("busctl", [
        "--user",
        "call",
        ...systemd,
        manager,
        "StartTransientUnit",
        "ssa(sv)a(sa(sv))",
        unit,
        "fail",
        "3",
        "PIDs",
        "au",
        "1",
        String(pid),
        "CollectMode",
        "s",
        "inactive-or-failed",
        "Description",
        "s",
        "ace member work",
        "0",
      ]);
      if (started.code !== 0) {
        const attached = await run("busctl", [
          "--user",
          "call",
          ...systemd,
          manager,
          "AttachProcessesToUnit",
          "ssau",
          unit,
          "",
          "1",
          String(pid),
        ]);
        if (attached.code !== 0) return false;
      }
      return inScope(pid, unit);
    },
    async kill(account) {
      const unit = memberScope(options.instance, account);
      const path = await controlGroup(unit);
      if (path) {
        // One write kills every process in the cgroup, a fork racing it included (Linux 5.14).
        const killed = await writeFile(`${root}${path}/cgroup.kill`, "1").then(
          () => true,
          () => false,
        );
        if (!killed) await run("systemctl", ["--user", "kill", "--signal=SIGKILL", unit]);
        const deadline = Date.now() + settleMs;
        while (Date.now() < deadline && !(await empty(path))) await delay(pollMs);
      }
      await fallback.kill(account);
    },
  };
}

/** The containment this platform has: a systemd scope on Linux, process groups elsewhere. */
export function memberContainment(platform: NodeJS.Platform, instance: string): Containment {
  return platform === "linux" ? systemdScopeContainment({ instance }) : processGroupContainment();
}
