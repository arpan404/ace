import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { LockedUseRuntime } from "./locked-use-runtime.ts";

const fakeService = fileURLToPath(import.meta.resolve("@ace/screen/testing/locked-use-service"));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), "ace-lur-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const started: { args: readonly string[]; child: ChildProcess }[] = [];
  let next = 0;
  let attempts = 0;
  const owner = new LockedUseRuntime({
    helper: async () => "ace-screen-helper",
    socketPath: join(dir, "s.sock"),
    nextId: () => `r${++next}`,
    attemptId: () => `attempt-${++attempts}`,
    scheduler: { after: (ms, run) => clearTimeout.bind(undefined, setTimeout(run, ms)) },
    spawnService: (_command, args) => {
      const child = spawn(process.execPath, [fakeService, ...args], { stdio: "ignore" });
      started.push({ args, child });
      return child;
    },
  });
  cleanups.push(async () => {
    owner.close();
    await Promise.all(started.map(({ child }) => exited(child)));
  });
  return { owner, started, socketPath: join(dir, "s.sock") };
}

it("the service starts only when first asked, then reports a verified locked Mac", async () => {
  const { owner, started, socketPath } = await runtime();
  expect(started).toEqual([]);
  expect(owner.verifiedAndLocked()).toBe(false);
  const status = await owner.refresh();
  expect(status).toMatchObject({ phase: "disabled", session: "locked" });
  expect(started.map(({ args }) => args)).toEqual([["--locked-use", "--socket", socketPath]]);
  expect(owner.verifiedAndLocked()).toBe(true);
});

it("a protected run returns the work's result after the service relocks", async () => {
  const { owner } = await runtime();
  const result = await owner.runProtected(
    { threadID: "thread-1", turnID: "run-1" },
    [process.pid],
    async (signal) => (signal.aborted ? "aborted" : "done"),
  );
  expect(result).toBe("done");
  expect(owner.status).toMatchObject({ phase: "ready", session: "locked" });
});

it("the service dying mid-work stops the attempt, and the next use starts a new service", async () => {
  const { owner, started } = await runtime();
  const aborted: boolean[] = [];
  const failed = await owner
    .runProtected({ threadID: "thread-1", turnID: "run-1" }, [process.pid], async (signal) => {
      started[0]?.child.kill("SIGKILL");
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      aborted.push(signal.aborted);
      return "must not be returned";
    })
    .catch((error: unknown) => error);
  expect(failed).toMatchObject({ code: "locked_use_connection_lost" });
  expect(aborted).toEqual([true]);
  expect(owner.verifiedAndLocked()).toBe(false);
  await expect(owner.refresh()).resolves.toMatchObject({ session: "locked" });
  expect(started).toHaveLength(2);
});
