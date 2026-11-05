import { spawnSync } from "node:child_process";
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

/** Running, rather than gone or a zombie waiting to be reaped. */
function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return state.stdout.trim() !== "" && !state.stdout.trim().startsWith("Z");
}

async function pidFile(): Promise<{ path: string; read: () => Promise<number> }> {
  const directory = await mkdtemp(join(tmpdir(), "ace-probe-pids-"));
  const path = join(directory, "pid");
  return {
    path,
    read: async () => {
      await expect.poll(() => readFile(path, "utf8").catch(() => "")).toMatch(/^\d+\n$/);
      return Number((await readFile(path, "utf8")).trim());
    },
  };
}

test("a probe of an executable that does not exist fails to start promptly and owns nothing", async () => {
  const recorded = new Set<number>();
  const stop = observeProcessGroups({
    add: (pid) => recorded.add(pid),
    remove: (pid) => recorded.delete(pid),
  });
  try {
    const started = performance.now();
    await expect(probeOutput("/nonexistent/ace-probe", ["--version"])).rejects.toThrow(
      "Probe failed to start",
    );
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(recorded.size).toBe(0);
  } finally {
    stop();
  }
});

test("an aborted probe takes the processes it started down with it", async () => {
  const helper = await pidFile();
  const controller = new AbortController();
  const probe = probeOutput(
    "/bin/sh",
    ["-c", `sleep 30 >/dev/null 2>&1 & echo $! > '${helper.path}'; sleep 30`],
    { signal: controller.signal },
  );
  const descendant = await helper.read();
  controller.abort();
  await expect(probe).rejects.toThrow("Probe aborted");
  await expect.poll(() => processRunning(descendant)).toBe(false);
});

test("a probe whose command exits leaves nothing it started running", async () => {
  const result = await probeOutput("/bin/sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"]);
  const descendant = Number(result.stdout);
  expect(descendant).toBeGreaterThan(0);
  await expect.poll(() => processRunning(descendant)).toBe(false);
});

test("a probe past its output budget is stopped with everything it started", async () => {
  const helper = await pidFile();
  const probe = probeOutput(
    "/bin/sh",
    ["-c", `sleep 30 >/dev/null 2>&1 & echo $! > '${helper.path}'; sleep 0.2; yes`],
    { maxBytes: 100 },
  );
  await expect(probe).rejects.toThrow("Probe output exceeded limit");
  const descendant = await helper.read();
  await expect.poll(() => processRunning(descendant)).toBe(false);
});
