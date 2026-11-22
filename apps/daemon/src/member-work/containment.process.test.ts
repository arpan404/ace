import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commandRunner, systemdScopeContainment } from "./containment.ts";

/*
 * Linux containment of a member's processes (ADR 0209 §7.3) against the real systemd user
 * manager and cgroup v2: a stop reaches a grandchild that left the process group and session
 * of the process ace started, which a process-group kill never reaches.
 */

// Tests run with a runtime directory of their own; the scope is made through the real user
// manager, as the daemon makes it, and killed before the test ends.
const runtime = `/run/user/${process.getuid?.() ?? 0}`;
const bus = {
  ...process.env,
  XDG_RUNTIME_DIR: runtime,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
};
const userManager =
  process.platform === "linux" &&
  existsSync(`${runtime}/bus`) &&
  spawnSync("systemctl", ["--user", "is-system-running"], {
    encoding: "utf8",
    env: bus,
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
  "stopping a member's work kills a grandchild that left its process group and session",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ace-member-scope-"));
    dirs.push(dir);
    const go = join(dir, "go");
    const inner = join(dir, "inner");
    const sleeper = join(dir, "sleeper");
    // Waits to be contained, then starts a new session that forks a long sleep, as a dev server
    // or a daemonizing tool does, and keeps running itself.
    const child = spawn(
      "sh",
      [
        "-c",
        `while [ ! -f "${go}" ]; do sleep 0.02; done
         setsid sh -c 'sleep 300 & echo $! > "${sleeper}"; echo $$ > "${inner}"; wait' &
         sleep 300`,
      ],
      { detached: true, stdio: "ignore" },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const pid = child.pid;
    if (pid === undefined) throw new Error("No child");
    const containment = systemdScopeContainment({ instance: dir, run: commandRunner(bus) });
    try {
      expect(await containment.contain("user_mia", pid)).toBe(true);
      writeFileSync(go, "");
      const [innerPid, sleeperPid] = await vi.waitFor(() => [read(inner), read(sleeper)], {
        timeout: 5_000,
      });
      expect(alive(innerPid) && alive(sleeperPid)).toBe(true);
      // It really left: a session of its own, so killing the started process's group misses it.
      expect(session(innerPid)).not.toBe(session(pid));

      await containment.kill("user_mia");

      await exited;
      await vi.waitFor(() => expect([alive(innerPid), alive(sleeperPid)]).toEqual([false, false]), {
        timeout: 5_000,
      });
    } finally {
      await containment.kill("user_mia");
    }
  },
);
