import { afterEach, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openHistory, type HistoryService, type ImportSink } from "./index.ts";
import { readerMemoryError, readerMemoryLimitBytes } from "./reader-process.ts";
import { residentSamplingAvailable } from "@ace/provider-kit/resident-memory";
import {
  environment,
  claudeRecords,
  cwd,
  init,
  readerHooks,
  readerStarts,
} from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** About 1 MB of JSON that parses to roughly 14 MB of arrays. */
const heavyLine =
  JSON.stringify({
    type: "progress",
    data: Array.from({ length: 250_000 }, () => [0]),
  }) + "\n";
/** Pushes the first prompt out of the sampled head window. */
const filler = JSON.stringify({ type: "summary", text: "x".repeat(70 * 1024) }) + "\n";

async function transcript(path: string, prompt: string, before = "") {
  await mkdir(dirname(path), { recursive: true });
  // The records carry the shared test cwd that titles() lists.
  const lines = claudeRecords(prompt, prompt.replaceAll(" ", "-")).map(
    (record) => JSON.stringify(record) + "\n",
  );
  await writeFile(path, filler + before + lines.join(""));
}

async function titles(service: HistoryService): Promise<string[]> {
  const page = await service.list({ type: "history.list", cwd, limit: 200 });
  return page.sessions.map((session) => session.title).toSorted();
}

test("transcripts with huge records before their first prompt scan stay under the reader's memory limit", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "claude");
  const expected: string[] = [];
  for (let i = 0; i < 32; i++) {
    expected.push("bulky prompt " + i);
    await transcript(
      join(home, "projects/p", i + ".jsonl"),
      "bulky prompt " + i,
      heavyLine.repeat(2),
    );
  }
  const service = await openHistory({
    indexPath: join(env.root, "ace/index.sqlite"),
    instances: [{ id: "claude", provider: "claude", homeDir: home }],
  });
  cleanup.push(() => service.close());
  let restarts = 0;
  service.subscribeRecovery((retrying) => {
    if (retrying) restarts++;
  });
  const scan = await service.scan();
  expect(restarts).toBe(0);
  expect(scan.unsupported).toEqual([]);
  expect(await titles(service)).toEqual(expected.toSorted());
});

// The real limit needs the real sampler: on macOS and Windows that is bun:ffi, the daemon's.
test.skipIf(!residentSamplingAvailable())(
  "a transcript that takes the reader past its memory limit is isolated and reported instead of restarting every scan",
  async () => {
    const env = await environment();
    cleanup.push(env.close);
    const home = join(env.root, "claude");
    const expected: string[] = [];
    for (let i = 0; i < 20; i++) {
      expected.push("healthy prompt " + i);
      await transcript(join(home, "projects/p", i + ".jsonl"), "healthy prompt " + i);
    }
    const poison = join(home, "projects/p", "poison.jsonl");
    await transcript(poison, "poison prompt");
    const starts = join(env.root, "starts.log");
    const service = await openHistory(
      {
        indexPath: join(env.root, "ace/index.sqlite"),
        instances: [{ id: "claude", provider: "claude", homeDir: home }],
      },
      {
        // The real reader and its real memory limit: decoding the poison transcript makes
        // ace-history resident past it (its poison test hook).
        ...readerHooks({
          poison: { marker: "poison prompt", bytes: readerMemoryLimitBytes + 64 * 1024 * 1024 },
          startLog: starts,
        }),
        delay: (run, milliseconds) => {
          // Retire-on-idle stays off; crash recovery runs without waiting out its backoff.
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
    // The daemon rescans after each recovery. Count how many rounds it takes to settle.
    let crashes = 0;
    let scan;
    while (!scan && crashes < 6) {
      try {
        scan = await service.scan();
      } catch (error) {
        expect(String(error)).toContain(readerMemoryError(readerMemoryLimitBytes).message);
        crashes++;
        await recovered.promise;
        recovered = Promise.withResolvers<void>();
      }
    }
    expect(crashes).toBeGreaterThan(0);
    expect(crashes).toBeLessThanOrEqual(2);
    expect(scan?.unsupported.map((entry) => entry.reason)).toEqual([
      expect.stringContaining("stopped the history reader"),
    ]);
    expect(await titles(service)).toEqual(expected.toSorted());
    const settled = (await readerStarts(starts)).length;
    for (let round = 0; round < 3; round++) {
      const again = await service.scan();
      expect(again.unsupported).toHaveLength(1);
    }
    expect(await readerStarts(starts)).toHaveLength(settled);
  },
);

test("a record of hundreds of thousands of tiny blocks imports within the reader's memory limit", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "claude");
  // Under the 1 MiB decode limit, yet one item per block: every block is of no known type.
  const blocks = Array.from({ length: 330_000 }, () => ({}));
  const lines = claudeRecords("many blocks", "many-blocks").map((record) => JSON.stringify(record));
  lines.push(
    JSON.stringify({
      type: "assistant",
      sessionId: "many-blocks",
      cwd,
      message: { role: "assistant", content: blocks },
    }),
  );
  expect(lines.at(-1)?.length).toBeLessThan(1024 * 1024);
  await mkdir(join(home, "projects/p"), { recursive: true });
  await writeFile(join(home, "projects/p/many.jsonl"), lines.join("\n") + "\n");
  const service = await openHistory({
    indexPath: join(env.root, "ace/index.sqlite"),
    instances: [{ id: "claude", provider: "claude", homeDir: home }],
  });
  cleanup.push(() => service.close());
  let restarts = 0;
  service.subscribeRecovery((retrying) => {
    if (retrying) restarts++;
  });
  await service.scan();
  const [source] = (await service.list({ type: "history.list", cwd })).sessions;
  if (!source) throw new Error("Missing session");
  let items = 0;
  const counting: ImportSink = {
    begin: async () => {},
    appendAgent: async () => {},
    appendItem: async () => void items++,
    beginBlob: async () => {},
    appendBlob: async () => {},
    endBlob: async () => {},
    commit: async () => {},
    rollback: async () => {},
  };
  await service.importSession(init(source.id), counting);
  expect(items).toBeGreaterThan(330_000);
  expect(restarts).toBe(0);
});
