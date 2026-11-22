import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MEMBER_SLICE_ENV } from "@ace/provider-kit/member-scope";

/*
 * Containment of a member's processes on an org host (ADR 0209 §7.3), so stopping their work
 * reaches every descendant, also one that left its process group (`setsid`, a double fork).
 *
 * Linux: a member tree's provider processes are started inside a systemd scope under that tree's
 * own slice, nested in the member's (`systemd-run --user --scope`, no delegation), so they are in
 * it before any provider code runs and everything they start is too. A scope that can't be made
 * starts nothing (provider-kit's `member-scope.ts`). Stopping a tree kills its slice's cgroup at
 * once (`cgroup.kill`) and counts only once the cgroup reads empty; a cgroup it can't read
 * stays unconfirmed. Sibling trees of the same member are untouched.
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
  /** Environment that starts a process of `account`'s tree `root` inside that tree's containment. */
  launchEnv(account: string, root: string): Record<string, string> | undefined;
  /**
   * Kills everything in tree `root`'s containment: true only once nothing in it is positively
   * known to run. Anything it can't read stays unconfirmed.
   */
  kill(account: string, root: string): Promise<boolean>;
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

const tag = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);

/**
 * The slice one member tree's processes run under: inside its member's slice (systemd nests
 * slices by their dashes), distinct per daemon home so hosts never share one.
 */
export function treeSlice(instance: string, account: string, root: string): string {
  return `ace-member-${tag(instance, account)}-${tag(instance, account, root)}.slice`;
}

/** `systemctl show` output, as `Name=value` lines. */
function properties(text: string): Map<string, string> {
  return new Map(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

/** A systemd slice per member tree, through the user's manager. `instance` names this home. */
export function systemdSliceContainment(options: {
  instance: string;
  run?: CommandRunner;
  /** Where cgroup v2 is mounted. */
  cgroupRoot?: string;
  /** How long a kill waits for the cgroup to empty. */
  settleMs?: number;
}): Containment {
  const run = options.run ?? commandRunner();
  const root = options.cgroupRoot ?? "/sys/fs/cgroup";
  const settle = options.settleMs ?? settleMs;

  /** Whether the cgroup holds a process: undefined when it can't be read. */
  async function populated(path: string): Promise<boolean | undefined> {
    const events = await readFile(`${root}${path}/cgroup.events`, "utf8").catch(() => undefined);
    const line = events?.match(/^populated ([01])$/m)?.[1];
    return line === undefined ? undefined : line === "1";
  }

  /** Whether the kernel has this cgroup: false only when it positively doesn't. */
  async function present(path: string): Promise<boolean> {
    return stat(`${root}${path}`).then(
      () => true,
      (error: unknown) => !(error instanceof Error && "code" in error && error.code === "ENOENT"),
    );
  }

  /**
   * Where systemd makes `unit`'s cgroup: under the user manager's own, one level per slice its
   * name nests in (`ace-member-a-b.slice` is in `ace-member-a.slice`, in `ace-member.slice`, in
   * `ace.slice`).
   */
  async function sliceCgroup(unit: string): Promise<string | undefined> {
    const shown = await run("systemctl", ["--user", "show", "--property=ControlGroup"]);
    const base = properties(shown.stdout).get("ControlGroup") ?? "";
    if (shown.code !== 0 || !base.startsWith("/")) return undefined;
    const parts = unit.replace(/\.slice$/, "").split("-");
    const nested = parts.map((_, index) => `${parts.slice(0, index + 1).join("-")}.slice`);
    return `${base}/${nested.join("/")}`;
  }

  return {
    kind: "cgroup",
    launchEnv: (account, tree) => ({
      [MEMBER_SLICE_ENV]: treeSlice(options.instance, account, tree),
    }),
    async kill(account, tree) {
      const unit = treeSlice(options.instance, account, tree);
      const shown = await run("systemctl", [
        "--user",
        "show",
        "--property=LoadState,ActiveState,ControlGroup",
        unit,
      ]);
      if (shown.code !== 0) return false;
      const unitState = properties(shown.stdout);
      const path = unitState.get("ControlGroup") ?? "";
      // systemd itself says it doesn't exist.
      if (unitState.get("LoadState") === "not-found") return true;
      // systemd names no cgroup for a slice it never made or has collected: read the kernel's own
      // at the place the slice's cgroup is made, under the user manager's.
      const cgroup = path.startsWith("/") ? path : await sliceCgroup(unit);
      if (cgroup === undefined) return false;
      if (!path.startsWith("/") && !(await present(cgroup))) return true;
      const before = await populated(cgroup);
      if (before === undefined) return false;
      if (!before) return true;
      // One write kills every process beneath the slice, a fork racing it included.
      const killed = await writeFile(`${root}${cgroup}/cgroup.kill`, "1").then(
        () => true,
        () => false,
      );
      if (!killed) await run("systemctl", ["--user", "kill", "--signal=SIGKILL", unit]);
      const deadline = Date.now() + settle;
      for (;;) {
        if ((await populated(cgroup)) === false) return true;
        if (Date.now() >= deadline) return false;
        await delay(pollMs);
      }
    },
  };
}

/** The containment this platform has: a systemd slice on Linux, the sessions elsewhere. */
export function memberContainment(platform: NodeJS.Platform, instance: string): Containment {
  return platform === "linux" ? systemdSliceContainment({ instance }) : sessionContainment;
}
