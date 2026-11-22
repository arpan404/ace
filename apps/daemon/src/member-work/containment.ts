import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MEMBER_SLICE_ENV } from "@ace/provider-kit/member-scope";

/*
 * Containment of a member's processes on an org host (ADR 0209 §7.3), so stopping their work
 * reaches every descendant, also one that left its process group (`setsid`, a double fork).
 *
 * Linux: a member's provider processes are started inside a systemd scope under the member's
 * own slice (`systemd-run --user --scope`, no delegation), so they are in it before any provider
 * code runs and everything they start is too. A scope that can't be made starts nothing
 * (provider-kit's `member-scope.ts`). Stopping kills the slice's cgroup at once (`cgroup.kill`)
 * and waits until it holds no process.
 *
 * The slice lives in the host user's own systemd tree, which that user can write. Making a
 * scope under the system manager without delegation would need root or a polkit grant for
 * managing units, which an unprivileged daemon doesn't have. So phase 1 containment stops
 * accidental escapes (dev servers, daemonizing tools, `setsid`), not a hostile member set on
 * leaving the cgroup: ADR 0209 §1's trusted-member boundary. Phase 2's separate OS users close it.
 *
 * Elsewhere (macOS in phase 1) it is best effort: a member's processes are their sessions'
 * process groups, which closing the session kills. A process that leaves its group outlives it.
 */

export interface Containment {
  readonly kind: "cgroup" | "session";
  /** Environment that starts a member's provider process inside their containment. */
  launchEnv(account: string): Record<string, string> | undefined;
  /** Kills everything in `account`'s containment: true once nothing in it runs. */
  kill(account: string): Promise<boolean>;
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

/** Only the sessions themselves: closing each kills its process group. */
export const sessionContainment: Containment = {
  kind: "session",
  launchEnv: () => undefined,
  kill: async () => true,
};

/** The slice a member's processes run under, distinct per daemon home so hosts never share one. */
export function memberSlice(instance: string, account: string): string {
  const tag = createHash("sha256").update(instance).update("\0").update(account).digest("hex");
  return `ace-member-${tag.slice(0, 24)}.slice`;
}

/** A systemd slice per member, through the user's manager. `instance` names this daemon's home. */
export function systemdSliceContainment(options: {
  instance: string;
  run?: CommandRunner;
  /** Where cgroup v2 is mounted. */
  cgroupRoot?: string;
}): Containment {
  const run = options.run ?? commandRunner();
  const root = options.cgroupRoot ?? "/sys/fs/cgroup";

  async function populated(path: string): Promise<boolean> {
    const events = await readFile(`${root}${path}/cgroup.events`, "utf8").catch(() => undefined);
    // Gone, or no process anywhere beneath it.
    return events !== undefined && /^populated 1$/m.test(events);
  }

  return {
    kind: "cgroup",
    launchEnv: (account) => ({ [MEMBER_SLICE_ENV]: memberSlice(options.instance, account) }),
    async kill(account) {
      const unit = memberSlice(options.instance, account);
      const shown = await run("systemctl", [
        "--user",
        "show",
        "--property=ControlGroup",
        "--value",
        unit,
      ]);
      if (shown.code !== 0) return false;
      const path = shown.stdout.trim();
      // Never loaded, or collected: nothing of the member's runs in it.
      if (!path.startsWith("/")) return true;
      if (!(await populated(path))) return true;
      // One write kills every process beneath the slice, a fork racing it included.
      const killed = await writeFile(`${root}${path}/cgroup.kill`, "1").then(
        () => true,
        () => false,
      );
      if (!killed) await run("systemctl", ["--user", "kill", "--signal=SIGKILL", unit]);
      const deadline = Date.now() + settleMs;
      while (Date.now() < deadline) {
        if (!(await populated(path))) return true;
        await delay(pollMs);
      }
      return false;
    },
  };
}

/** The containment this platform has: a systemd slice on Linux, the sessions elsewhere. */
export function memberContainment(platform: NodeJS.Platform, instance: string): Containment {
  return platform === "linux" ? systemdSliceContainment({ instance }) : sessionContainment;
}
