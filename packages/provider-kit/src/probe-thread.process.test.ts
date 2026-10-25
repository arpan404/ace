import { expect, test } from "vitest";
import { OutputLimitError } from "./output-budget.ts";
import { createProbeThread } from "./probe-thread.ts";
import { observeProcessGroups, probeOutput } from "./process.ts";

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

test("output past the byte budget fails the probe", async () => {
  await expect(
    probeOutput("/bin/sh", ["-c", "head -c 100000 /dev/zero"], { maxBytes: 1024 }),
  ).rejects.toBeInstanceOf(OutputLimitError);
});

test("a command that cannot start fails without hanging", async () => {
  await expect(probeOutput("/nonexistent/ace-probe", [])).rejects.toThrow("Probe failed to start");
});

test("an aborted probe stops", async () => {
  const controller = new AbortController();
  const running = probeOutput("/bin/sh", ["-c", "sleep 30"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await expect(running).rejects.toThrow("Probe aborted");
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
