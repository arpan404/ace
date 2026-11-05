import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createProbeThread } from "./probe-thread.ts";
import { observeProcessGroups, probeOutput, stopOwnedGroups } from "./process.ts";

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

test("a probe returns its output and exit code", async () => {
  await expect(
    probeOutput("/bin/sh", ["-c", "printf ' out \\n'; printf err >&2; exit 3"]),
  ).resolves.toEqual({ stdout: "out", stderr: "err", code: 3 });
});

test("a probe of a command that is not installed fails to start instead of hanging", async () => {
  await expect(
    probeOutput("ace-probe-missing-command", ["--version"], {
      env: { PATH: "/nonexistent-ace-probe-path" },
      timeoutMs: 10_000,
    }),
  ).rejects.toThrow("Probe failed to start");
});

test("a probe sees its own environment over the daemon's", async () => {
  const result = await probeOutput("/bin/sh", ["-c", 'printf "$ACE_PROBE_VALUE"'], {
    env: { ACE_PROBE_VALUE: "chosen" },
  });
  expect(result.stdout).toBe("chosen");
});

test("a variable the caller unsets stays unset even though the daemon has it", async () => {
  process.env.ACE_PROBE_UNSET = "daemon";
  process.env.ACE_PROBE_KEPT = "daemon";
  try {
    // The worker starts after both are set, so its own copy of the environment holds them.
    const thread = createProbeThread();
    const result = await probeOutput(
      "/bin/sh",
      ["-c", 'printf "%s|%s" "${ACE_PROBE_UNSET-unset}" "$ACE_PROBE_KEPT"'],
      { env: { ACE_PROBE_UNSET: undefined }, thread },
    );
    expect(result.stdout).toBe("unset|daemon");
  } finally {
    delete process.env.ACE_PROBE_UNSET;
    delete process.env.ACE_PROBE_KEPT;
  }
});

test("a probe past its timeout is stopped with its descendants and no longer owned", async () => {
  const recorded = new Set<number>();
  const stop = observeProcessGroups({
    add: (pid) => recorded.add(pid),
    remove: (pid) => recorded.delete(pid),
  });
  try {
    const running = probeOutput("/bin/sh", ["-c", "sleep 30 & sleep 30"], { timeoutMs: 300 });
    await expect.poll(() => recorded.size).toBe(1);
    const [pid] = recorded;
    if (pid === undefined) throw new Error("Probe was never recorded");
    await expect(running).rejects.toThrow("Probe timed out");
    expect(recorded.size).toBe(0);
    await expect.poll(() => groupAlive(pid)).toBe(false);
  } finally {
    stop();
  }
});

test("a reply the main thread can't read fails its probe instead of leaving it waiting", async () => {
  const thread = createProbeThread(new URL("./testing/malformed-probe-worker.ts", import.meta.url));
  await expect(probeOutput("anything", [], { thread })).rejects.toThrow("invalid reply");
});

test("an unreadable spawn reply stops the probe's process and keeps owning it until it ends", async () => {
  const thread = createProbeThread(new URL("./testing/pidless-probe-worker.ts", import.meta.url));
  const pidFile = join(await mkdtemp(join(tmpdir(), "ace-probe-pid-")), "pid");
  const recorded = new Set<number>();
  const stopObserving = observeProcessGroups({
    add: (pid) => recorded.add(pid),
    remove: (pid) => recorded.delete(pid),
  });
  try {
    const running = probeOutput("/bin/sh", ["-c", "sleep 30 & sleep 30"], {
      thread,
      env: { ACE_PROBE_PID_FILE: pidFile },
    });
    await expect(running).rejects.toThrow("invalid reply");
    // The probe gives up its ownership only once its process group is gone.
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(groupAlive(pid)).toBe(false);
    // The main thread never learned the pid, so it never recorded the group.
    expect(recorded.size).toBe(0);
  } finally {
    stopObserving();
  }
});

test("a spawn that blocks its thread leaves the main thread answering", async () => {
  const thread = createProbeThread(new URL("./testing/slow-probe-worker.ts", import.meta.url));
  let last = performance.now();
  let widest = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    widest = Math.max(widest, now - last);
    last = now;
  }, 10);
  try {
    const result = await probeOutput("anything", [], { thread });
    expect(result.stdout).toBe("slow");
    expect(widest).toBeLessThan(150);
  } finally {
    clearInterval(beat);
  }
});

test.each([false, true])(
  "a global stop returns only after a probe has ended (pid reported first: %s)",
  async (reported) => {
    const seen: number[] = [];
    const recorded = new Set<number>();
    const stop = observeProcessGroups({
      add: (pid) => {
        seen.push(pid);
        recorded.add(pid);
      },
      remove: (pid) => recorded.delete(pid),
    });
    try {
      const running = probeOutput("/bin/sh", ["-c", "sleep 30 & sleep 30"]);
      void running.catch(() => {});
      // Unreported, the probe is still waiting on the worker for its pid.
      if (reported) await expect.poll(() => recorded.size).toBe(1);
      await stopOwnedGroups(0);
      expect(seen).toHaveLength(1);
      expect(recorded.size).toBe(0);
      expect(seen.map(groupAlive)).toEqual([false]);
      await running;
    } finally {
      stop();
    }
  },
);
