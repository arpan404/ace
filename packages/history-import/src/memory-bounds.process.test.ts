import { afterEach, expect, test } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openHistory, type HistoryService } from "./index.ts";
import { environment, claudeRecords, cwd } from "./test-support.ts";

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

test("transcripts with huge records before their first prompt scan under the production heap limit", async () => {
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

test("a transcript that exhausts the reader is isolated and reported instead of restarting every scan", async () => {
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
  let launches = 0;
  const service = await openHistory(
    {
      indexPath: join(env.root, "ace/index.sqlite"),
      instances: [{ id: "claude", provider: "claude", homeDir: home }],
    },
    (url, options) => {
      launches++;
      return new Worker(url, {
        ...options,
        env: { ...process.env, ACE_TEST_POISON: poison },
        execArgv: ["--import", new URL("./poison-preload.ts", import.meta.url).href],
      });
    },
    {
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
      expect(String(error)).toMatch(/memory/);
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
  const settled = launches;
  for (let round = 0; round < 3; round++) {
    const again = await service.scan();
    expect(again.unsupported).toHaveLength(1);
  }
  expect(launches).toBe(settled);
});
