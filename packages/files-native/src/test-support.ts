import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FilesChild, FilesClock, FilesHost } from "./host.ts";
import { nodeFilesHost } from "./host.ts";
import { FilesProcess } from "./process.ts";
import { messageSchema, type Message } from "./schemas.ts";

/** A clock whose timers run only when the test advances it. */
export class ManualClock implements FilesClock {
  #now = 0;
  #timers: { at: number; seq: number; run: () => void }[] = [];
  #seq = 0;

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): () => void {
    const timer = { at: this.#now + ms, seq: this.#seq++, run: callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((candidate) => candidate !== timer);
    };
  }

  /** Runs every timer due within `ms`, in order, letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      await settle();
      const next = this.#timers
        .filter((timer) => timer.at <= end)
        .toSorted((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((timer) => timer !== next);
      this.#now = next.at;
      next.run();
    }
    this.#now = end;
    await settle();
  }
}

/** Let queued promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Wait for a condition a real child process makes true, with a generous deadline. */
export async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting for the fake ace-files");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A host that remembers every child it spawned, so a test can kill one. */
export type TrackingHost = FilesHost & { readonly children: FilesChild[] };

export function trackingHost(inner: FilesHost): TrackingHost {
  const children: FilesChild[] = [];
  return {
    children,
    spawn(binary) {
      const child = inner.spawn(binary);
      children.push(child);
      return child;
    },
  };
}

/** The Bun script that speaks files-wire in place of the real binary. */
export function fakeFilesScript(): string {
  return fileURLToPath(new URL("../test-support/fake-ace-files.ts", import.meta.url));
}

export type FakeFilesBehaviour = "answer" | "hang" | "exit" | "oversize";

export type FakeFilesHarness = {
  dir: string;
  files: FilesProcess;
  clock: ManualClock;
  host: TrackingHost;
  logPath: string;
};

/** A process wired to the fake binary, a manual clock and a log the test can read. */
export function fakeFilesHarness(behaviour: FakeFilesBehaviour = "answer"): FakeFilesHarness {
  const dir = mkdtempSync(join(tmpdir(), "ace-files-native-"));
  const logPath = join(dir, "fake.log");
  writeFileSync(logPath, "");
  const clock = new ManualClock();
  const host = trackingHost(
    nodeFilesHost(
      { ...process.env, FAKE_FILES_BEHAVIOUR: behaviour, FAKE_FILES_LOG: logPath },
      () => ({ command: process.execPath, args: [fakeFilesScript()] }),
    ),
  );
  const files = new FilesProcess({ binary: "/fake/ace-files", host, clock, log: () => {} });
  return { dir, files, clock, host, logPath };
}

/** Kill the process, its earlier runs, and remove the harness's folder. */
export async function stopFakeFiles(h: FakeFilesHarness): Promise<void> {
  h.files.dispose();
  for (const child of h.host.children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  rmSync(h.dir, { recursive: true, force: true });
}

const logged = z.union([
  z.object({ event: z.literal("spawn"), pid: z.number(), generation: z.number() }),
  z.object({ event: z.literal("message"), pid: z.number(), message: messageSchema }),
  z.object({ event: z.literal("body"), pid: z.number(), id: z.number(), bytes: z.number() }),
]);

export type FakeFilesLog = z.infer<typeof logged>;

/** Everything the fake binary has written to its log so far, whole lines only. */
export function fakeFilesEntries(h: FakeFilesHarness): FakeFilesLog[] {
  return readFileSync(h.logPath, "utf8")
    .split("\n")
    .filter((line) => line.endsWith("}"))
    .map((line) => logged.parse(JSON.parse(line)));
}

export function fakeSpawnCount(h: FakeFilesHarness): number {
  return fakeFilesEntries(h).filter((entry) => entry.event === "spawn").length;
}

/** Every message the fake binary received, in order. */
export function fakeMessages(h: FakeFilesHarness): Message[] {
  return fakeFilesEntries(h).flatMap((entry) => (entry.event === "message" ? [entry.message] : []));
}

/** The body frames the fake binary received, in order. */
export function fakeBodies(h: FakeFilesHarness): { id: number; bytes: number }[] {
  return fakeFilesEntries(h).flatMap((entry) =>
    entry.event === "body" ? [{ id: entry.id, bytes: entry.bytes }] : [],
  );
}
