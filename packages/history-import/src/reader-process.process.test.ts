import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openHistory } from "./index.ts";
import {
  ReaderProcess,
  readerMemoryError,
  readerMemoryLimitBytes,
  systemReaderRuntime,
} from "./reader-process.ts";
import { claudeRecords, cwd, environment } from "./test-support.ts";

// Real reader processes: their ownership, watchdog and exit are process behaviour.
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const poison = new URL("./poison-preload.ts", import.meta.url).href;
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
async function stuckHome(root: string) {
  const home = join(root, "claude");
  await transcript(join(home, "projects/p/healthy.jsonl"), "healthy prompt");
  await transcript(join(home, "projects/p/stuck.jsonl"), "stuck prompt");
  const signal = join(root, "stuck");
  const env = {
    ...process.env,
    ACE_TEST_POISON_MARKER: "stuck prompt",
    ACE_TEST_POISON_BYTES: "0",
    ACE_TEST_POISON_SIGNAL: signal,
  };
  return { home, signal, env };
}

test("a reader over its memory limit is killed, its in-flight requests fail with the memory error, and the next request works after it restarts", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const { home, signal, env: readerEnv } = await stuckHome(env.root);
  // Against the real limit, the sampler reports the reader that is stuck as over it, once the
  // test has its requests in flight.
  let armed = false;
  const stuck = (pid: number) =>
    armed && existsSync(signal) && readFileSync(signal, "utf8") === String(pid);
  const resident = (pid: number) => (stuck(pid) ? readerMemoryLimitBytes + 1 : 64 * 1024 * 1024);
  const readers: ReaderProcess[] = [];
  const service = await openHistory(
    {
      indexPath: join(env.root, "ace/index.sqlite"),
      instances: [{ id: "claude", provider: "claude", homeDir: home }],
    },
    (url, options) => {
      const reader = new ReaderProcess(
        url,
        { ...options, execArgv: ["--import", poison], env: readerEnv },
        { ...systemReaderRuntime(), intervalMs: 20, sample: async (pid) => resident(pid) },
      );
      readers.push(reader);
      return reader;
    },
    {
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
  // A read waiting behind the stuck reader fails the same way.
  const listing = service.list({ type: "history.list", cwd });
  void listing.catch(() => {});
  const first = readers[0]?.processId;
  if (first === undefined) throw new Error("The reader never started");
  armed = true;
  await expect(scanning).rejects.toThrow(message);
  await expect(listing).rejects.toThrow(message);
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
  expect(readers).toHaveLength(kills + 1);
  for (let round = 0; round < 3; round++) await service.scan();
  expect(readers).toHaveLength(kills + 1);
});

test("the reader exits when the daemon that owns it is killed outright, even while it is stuck", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const { home, signal, env: readerEnv } = await stuckHome(env.root);
  // The daemon: opens history with a real reader, starts a scan that leaves it stuck, and
  // prints the reader's pid. Inputs go by environment (Bun run as node drops --eval's first).
  const daemon = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import { openHistory } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      import { ReaderProcess, systemReaderRuntime } from ${JSON.stringify(new URL("./reader-process.ts", import.meta.url).href)};
      const input = JSON.parse(process.env.ACE_TEST_DAEMON);
      let reader;
      const service = await openHistory(
        { indexPath: input.index, instances: [{ id: "claude", provider: "claude", homeDir: input.home }] },
        (url, options) => (reader = new ReaderProcess(url, { ...options, execArgv: ["--import", input.poison] }, systemReaderRuntime())),
      );
      void service.scan().catch(() => {});
      console.log(reader.processId);
      setInterval(() => {}, 1000);
      `,
    ],
    {
      env: {
        ...readerEnv,
        ACE_TEST_DAEMON: JSON.stringify({
          index: join(env.root, "ace/index.sqlite"),
          home,
          poison,
        }),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  cleanup.push(() => void daemon.kill("SIGKILL"));
  let output = "";
  daemon.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  await vi.waitFor(() => expect(output).toMatch(/^\d+\n/), { timeout: 15_000 });
  const reader = Number(output.trim());
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
