import { expect, test } from "vitest";
import { startupProbes } from "./startup-probes.ts";

type Result = { stdout: string; stderr: string; code: number | null };

/** A CLI that answers when told to, recording every run and the signal it ran with. */
function fakeCli() {
  const runs: { args: readonly string[]; signal?: AbortSignal; answer(stdout: string): void }[] =
    [];
  const probe = (
    _command: string,
    args: readonly string[],
    options: { signal?: AbortSignal } = {},
  ) =>
    new Promise<Result>((resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("Probe aborted")));
      runs.push({
        args,
        ...(options.signal ? { signal: options.signal } : {}),
        answer: (stdout) => resolve({ stdout, stderr: "", code: 0 }),
      });
    });
  return { probe, runs };
}

/** Timers that fire only when the test says so, by their delay. */
function timers() {
  const pending = new Map<() => void, number>();
  return {
    schedule(callback: () => void, milliseconds: number) {
      pending.set(callback, milliseconds);
      return () => pending.delete(callback);
    },
    expire(milliseconds: number) {
      for (const [callback, delay] of pending)
        if (delay === milliseconds) {
          pending.delete(callback);
          callback();
        }
    },
  };
}

const env = { PATH: "/bin", HOME: "/home/person" };

test("status and engine discovery asking the same CLI the same question run it once", async () => {
  const cli = fakeCli();
  const probes = startupProbes({ probe: cli.probe, schedule: timers().schedule });
  const status = probes.probe("/bin/claude", ["--version"], { env, timeoutMs: 4000 });
  const engine = probes.probe("/bin/claude", ["--version"], { env, timeoutMs: 10_000 });
  expect(cli.runs).toHaveLength(1);
  cli.runs[0]?.answer("2.1.0 (Claude Code)");
  await expect(status).resolves.toMatchObject({ stdout: "2.1.0 (Claude Code)" });
  await expect(engine).resolves.toMatchObject({ stdout: "2.1.0 (Claude Code)" });
  // The engine asks after status already finished: the answer still stands during startup.
  await expect(probes.probe("/bin/claude", ["--version"], { env })).resolves.toMatchObject({
    stdout: "2.1.0 (Claude Code)",
  });
  expect(cli.runs).toHaveLength(1);
});

test("a different question, executable or environment runs its own probe", async () => {
  const cli = fakeCli();
  const probes = startupProbes({ probe: cli.probe, schedule: timers().schedule });
  void probes.probe("/bin/claude", ["--version"], { env });
  void probes.probe("/bin/claude", ["auth", "status"], { env });
  void probes.probe("/bin/codex", ["--version"], { env });
  void probes.probe("/bin/claude", ["--version"], { env: { ...env, HOME: "/accounts/work" } });
  expect(cli.runs).toHaveLength(4);
});

test("after close every check runs the CLI again, so a new login is observed", async () => {
  const cli = fakeCli();
  const probes = startupProbes({ probe: cli.probe, schedule: timers().schedule });
  const first = probes.probe("/bin/codex", ["login", "status"], { env });
  cli.runs[0]?.answer("Not logged in");
  await first;
  probes.close();
  const after = probes.probe("/bin/codex", ["login", "status"], { env });
  expect(cli.runs).toHaveLength(2);
  cli.runs[1]?.answer("Logged in using ChatGPT");
  await expect(after).resolves.toMatchObject({ stdout: "Logged in using ChatGPT" });
});

test("a caller keeps its own timeout while another waits for the shared run", async () => {
  const cli = fakeCli();
  const clock = timers();
  const probes = startupProbes({ probe: cli.probe, schedule: clock.schedule });
  const status = probes.probe("/bin/opencode", ["--version"], { env, timeoutMs: 4000 });
  const engine = probes.probe("/bin/opencode", ["--version"], { env, timeoutMs: 10_000 });
  clock.expire(4000);
  await expect(status).rejects.toThrow("Probe timed out");
  cli.runs[0]?.answer("1.4.0");
  await expect(engine).resolves.toMatchObject({ stdout: "1.4.0" });
  expect(cli.runs).toHaveLength(1);
});

test("the shared run stops once every caller has gone, and a failure is tried again", async () => {
  const cli = fakeCli();
  const probes = startupProbes({ probe: cli.probe, schedule: timers().schedule });
  const one = new AbortController();
  const two = new AbortController();
  const first = probes.probe("/bin/claude", ["auth", "status"], { env, signal: one.signal });
  const second = probes.probe("/bin/claude", ["auth", "status"], { env, signal: two.signal });
  one.abort();
  await expect(first).rejects.toThrow("Probe aborted");
  expect(cli.runs[0]?.signal?.aborted).toBe(false);
  two.abort();
  await expect(second).rejects.toThrow("Probe aborted");
  expect(cli.runs[0]?.signal?.aborted).toBe(true);
  const retry = probes.probe("/bin/claude", ["auth", "status"], { env });
  expect(cli.runs).toHaveLength(2);
  cli.runs[1]?.answer("{}");
  await expect(retry).resolves.toMatchObject({ stdout: "{}" });
});
