import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openHistory } from "./index.ts";
import { readerMemoryError, readerMemoryLimitBytes } from "./reader-process.ts";
import { claudeRecords, cwd, environment, readerHooks, readerStarts } from "./test-support.ts";

// Real reader processes: their ownership, watchdog and exit are process behaviour.
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function transcript(path: string, prompt: string) {
  await mkdir(dirname(path), { recursive: true });
  const lines = claudeRecords(prompt, prompt.replaceAll(" ", "-")).map((r) => JSON.stringify(r));
  await writeFile(path, lines.join("\n") + "\n");
}

/** A home where reading one transcript leaves the reader stuck until something kills it. */
async function stuckHome(root: string, healthy = true) {
  const home = join(root, "claude");
  if (healthy) await transcript(join(home, "projects/p/healthy.jsonl"), "healthy prompt");
  await transcript(join(home, "projects/p/stuck.jsonl"), "stuck prompt");
  const signal = join(root, "stuck");
  const starts = join(root, "starts.log");
  // Decoding the stuck transcript hangs the reader (ace-history's poison test hook).
  const hooks = { poison: { marker: "stuck prompt", bytes: 0, signal }, startLog: starts };
  return { home, signal, hooks, starts };
}

test("a reader over its memory limit is killed, its in-flight requests fail with the memory error, and the next request works after it restarts", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const { home, signal, hooks, starts } = await stuckHome(env.root);
  // Against the real limit, the sampler reports the reader that is stuck as over it, once the
  // test has its requests in flight.
  let armed = false;
  const stuck = (pid: number) =>
    armed && existsSync(signal) && readFileSync(signal, "utf8") === String(pid);
  const resident = (pid: number) => (stuck(pid) ? readerMemoryLimitBytes + 1 : 64 * 1024 * 1024);
  const service = await openHistory(
    {
      indexPath: join(env.root, "ace/index.sqlite"),
      instances: [{ id: "claude", provider: "claude", homeDir: home }],
    },
    {
      ...readerHooks(hooks),
      reader: { intervalMs: 20, sample: async (pid) => resident(pid) },
      delay: (run, milliseconds) => {
        // Retire-on-idle stays off; the restart runs without waiting out its backoff.
        if (milliseconds === 5000) return () => {};
        const timer = setTimeout(run, 0);
        return () => clearTimeout(timer);
      },
    },
  );
  cleanup.push(() => service.close());
  let recovered = Promise.withResolvers<void>();
  service.subscribeRecovery((retrying) => {
    if (!retrying) recovered.resolve();
  });
  const message = readerMemoryError(readerMemoryLimitBytes).message;

  const scanning = service.scan();
  void scanning.catch(() => {});
  await vi.waitFor(() => expect(existsSync(signal)).toBe(true), { timeout: 10_000 });
  // Lists are answered on a thread of their own, so one sent now is not stuck behind the scan.
  const listing = service.list({ type: "history.list", cwd });
  void listing.catch(() => {});
  await expect(listing).resolves.toMatchObject({ type: "history.list" });
  const first = (await readerStarts(starts))[0];
  if (first === undefined) throw new Error("The reader never started");
  armed = true;
  await expect(scanning).rejects.toThrow(message);
  await vi.waitFor(() => expect(alive(first)).toBe(false));

  // The daemon rescans after each recovery, as it does after a crash. The transcript the reader
  // was stuck on is set aside within two kills; then the restarted reader answers.
  let kills = 1;
  let scan;
  while (!scan && kills <= 2) {
    await recovered.promise;
    recovered = Promise.withResolvers<void>();
    try {
      scan = await service.scan();
    } catch (error) {
      expect(String(error)).toContain(message);
      kills++;
    }
  }
  expect(scan?.unsupported.map((entry) => entry.reason)).toEqual([
    expect.stringContaining("stopped the history reader"),
  ]);
  const page = await service.list({ type: "history.list", cwd });
  expect(page.sessions.map((session) => session.title)).toEqual(["healthy prompt"]);
  // One reader per kill, plus the one that answers, and no more however often it is asked.
  expect(await readerStarts(starts)).toHaveLength(kills + 1);
  for (let round = 0; round < 3; round++) await service.scan();
  expect(await readerStarts(starts)).toHaveLength(kills + 1);
});

test("the reader exits when the daemon that owns it is killed outright, even while it is stuck", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const { home, signal, hooks, starts } = await stuckHome(env.root);
  // The daemon: opens history with a real reader and starts a scan that leaves it stuck. Inputs
  // go by environment (Bun run as node drops --eval's first).
  const daemon = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import { openHistory } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      const input = JSON.parse(process.env.ACE_TEST_DAEMON);
      const service = await openHistory(
        { indexPath: input.index, instances: [{ id: "claude", provider: "claude", homeDir: input.home }] },
        { readerEnv: input.readerEnv },
      );
      void service.scan().catch(() => {});
      setInterval(() => {}, 1000);
      `,
    ],
    {
      env: {
        ...process.env,
        ACE_TEST_DAEMON: JSON.stringify({
          index: join(env.root, "ace/index.sqlite"),
          home,
          ...readerHooks(hooks),
        }),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  cleanup.push(() => void daemon.kill("SIGKILL"));
  await vi.waitFor(async () => expect(await readerStarts(starts)).toHaveLength(1), {
    timeout: 15_000,
  });
  const reader = (await readerStarts(starts))[0] ?? 0;
  cleanup.push(() => {
    if (alive(reader)) process.kill(reader, "SIGKILL");
  });
  await vi.waitFor(() => expect(existsSync(signal)).toBe(true), { timeout: 10_000 });
  expect(alive(reader)).toBe(true);

  // No exit handler runs in a daemon killed this way, and the stuck reader can't see its channel
  // close; it must still go.
  daemon.kill("SIGKILL");
  await vi.waitFor(() => expect(alive(reader)).toBe(false), { timeout: 5_000 });
});

/** A service whose reader gets stuck on one transcript, and a sampler the test can arm. */
async function stuckService(root: string, once = false, healthy = true) {
  const { home, signal, hooks, starts } = await stuckHome(root, healthy);
  const state = { armed: false };
  // Against the real limit, the sampler reports the stuck reader as over it once armed.
  const resident = (pid: number) =>
    state.armed && existsSync(signal) && readFileSync(signal, "utf8") === String(pid)
      ? readerMemoryLimitBytes + 1
      : 64 * 1024 * 1024;
  const service = await openHistory(
    {
      indexPath: join(root, "ace/index.sqlite"),
      instances: [{ id: "claude", provider: "claude", homeDir: home }],
    },
    {
      ...readerHooks({ ...hooks, poison: { ...hooks.poison, once } }),
      reader: { intervalMs: 20, sample: async (pid) => resident(pid) },
      delay: (run, milliseconds) => {
        if (milliseconds === 5000) return () => {};
        const timer = setTimeout(run, 0);
        return () => clearTimeout(timer);
      },
    },
  );
  cleanup.push(() => service.close());
  let recovered = Promise.withResolvers<void>();
  service.subscribeRecovery((retrying) => {
    if (!retrying) recovered.resolve();
  });
  return {
    service,
    signal,
    state,
    starts,
    async recovered() {
      await recovered.promise;
      recovered = Promise.withResolvers<void>();
    },
  };
}

test("a reader killed with many requests outstanding settles every one, and the daemon goes on", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const { service, signal, starts, recovered } = await stuckService(env.root);
  const scanning = service.scan();
  void scanning.catch(() => {});
  await vi.waitFor(() => expect(existsSync(signal)).toBe(true), { timeout: 10_000 });
  // Within the service's eight reads in flight, so each late one is really sent.
  const reads = Array.from({ length: 2 }, () => service.list({ type: "history.list", cwd }));
  const pid = (await readerStarts(starts))[0];
  if (pid === undefined) throw new Error("The reader never started");
  process.kill(pid, "SIGKILL");
  // Let the pipe close before this process hears of it, so the next sends fail one by one.
  const until = performance.now() + 20;
  while (performance.now() < until);
  const late = Array.from({ length: 5 }, () => service.get("missing"));

  const outcomes = await Promise.allSettled([scanning, ...reads, ...late]);
  expect(outcomes[0]?.status).toBe("rejected");
  expect(outcomes).toHaveLength(8);
  await recovered();
  const page = await service.list({ type: "history.list", cwd });
  expect(page.type).toBe("history.list");
});

test("a read in flight when the reader goes over its memory limit is re-checked alone, not set aside", async () => {
  const env = await environment();
  cleanup.push(env.close);
  // The stuck transcript is healthy: only the first reader stops on it, as if it was being
  // read when memory another read had used (and freed) pushed the reader over. It is the only
  // read marked then, the case a crash would strike.
  const { service, signal, state, recovered } = await stuckService(env.root, true, false);
  const scanning = service.scan();
  void scanning.catch(() => {});
  await vi.waitFor(() => expect(existsSync(signal)).toBe(true), { timeout: 10_000 });
  state.armed = true;
  await expect(scanning).rejects.toThrow(readerMemoryError(readerMemoryLimitBytes).message);
  await recovered();

  const scan = await service.scan();
  expect(scan.unsupported).toEqual([]);
  const page = await service.list({ type: "history.list", cwd });
  expect(page.sessions.map((session) => session.title)).toEqual(["stuck prompt"]);
});
