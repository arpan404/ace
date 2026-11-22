import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { commandRunner, systemdSliceContainment } from "./containment.ts";

/*
 * Linux containment of a member's processes (ADR 0209 §7.3) against the real systemd user
 * manager and cgroup v2. A member's process starts inside their slice before any of its code
 * runs, so a grandchild it forks at once, into a session of its own, is inside too and dies with
 * the stop. When the scope can't be made, the process never runs.
 */

// Tests run with a runtime directory of their own; the scope is made through the real user
// manager, as the daemon makes it, and killed before the test ends.
const runtime = `/run/user/${process.getuid?.() ?? 0}`;
const bus = {
  XDG_RUNTIME_DIR: runtime,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
};
const userManager =
  process.platform === "linux" &&
  existsSync(`${runtime}/bus`) &&
  spawnSync("systemctl", ["--user", "is-system-running"], {
    encoding: "utf8",
    env: { ...process.env, ...bus },
  }).stdout.trim() !== "";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Whether `pid` still runs: not gone, and not a zombie waiting to be reaped. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}
/** The pid a file holds, once its writer wrote it. */
function read(path: string): number {
  const text = readFileSync(path, "utf8").trim();
  if (!text) throw new Error("Not yet");
  return Number(text);
}
const session = (pid: number) =>
  Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[3]);

it.skipIf(!userManager)(
  "a member's process starts inside their slice, so a grandchild it forks at once dies with the stop",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ace-member-slice-"));
    dirs.push(dir);
    const inner = join(dir, "inner");
    const sleeper = join(dir, "sleeper");
    const containment = systemdSliceContainment({
      instance: dir,
      run: commandRunner({ ...process.env, ...bus }),
    });
    const env = containment.launchEnv("user_mia", "t_one");
    const sibling = containment.launchEnv("user_mia", "t_two");
    if (!env || !sibling) throw new Error("No containment");
    // Another of Mia's trees, running beside it in a slice of its own.
    const other = spawnRawSupervised({
      command: "sleep",
      args: ["300"],
      env: { ...bus, ...sibling },
      name: "member work",
      childPriority: false,
    });
    // At once, before anything could move it: a new session that forks a long sleep, as a dev
    // server or a daemonizing tool does.
    const child = spawnRawSupervised({
      command: "sh",
      args: [
        "-c",
        `setsid sh -c 'sleep 300 & echo $! > "${sleeper}"; echo $$ > "${inner}"; wait' &
         sleep 300`,
      ],
      env: { ...bus, ...env },
      name: "member work",
      childPriority: false,
    });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("No child");
      const [innerPid, sleeperPid] = await vi.waitFor(() => [read(inner), read(sleeper)], {
        timeout: 5_000,
      });
      expect(alive(innerPid) && alive(sleeperPid)).toBe(true);
      // It really left: a session of its own, so killing the started process's group misses it.
      expect(session(innerPid)).not.toBe(session(pid));
      // The slice's name never reaches the process itself.
      expect(readFileSync(`/proc/${pid}/environ`, "utf8")).not.toContain("ACE_MEMBER_SLICE");

      expect(await containment.kill("user_mia", "t_one")).toBe(true);

      await child.exited;
      expect([alive(innerPid), alive(sleeperPid)]).toEqual([false, false]);
      // The sibling tree is untouched.
      expect(other.pid !== undefined && alive(other.pid)).toBe(true);
    } finally {
      await containment.kill("user_mia", "t_one");
      await containment.kill("user_mia", "t_two");
      await child.stop({ graceMs: 0 });
      await other.stop({ graceMs: 0 });
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "a member's process whose scope can't be made never runs",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ace-member-slice-"));
    dirs.push(dir);
    const ran = join(dir, "ran");
    const env = systemdSliceContainment({ instance: dir }).launchEnv("user_mia", "t_one");
    const child = spawnRawSupervised({
      command: "sh",
      args: ["-c", `echo yes > "${ran}"`],
      // No systemd manager answers here.
      env: {
        ...env,
        XDG_RUNTIME_DIR: join(dir, "none"),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "none", "bus")}`,
      },
      name: "member work",
      childPriority: false,
    });
    const exit = await child.exited;
    expect(exit.code).not.toBe(0);
    expect(existsSync(ran)).toBe(false);
  },
);
