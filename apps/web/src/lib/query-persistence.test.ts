import type { ReadSnapshotStorage } from "@ace/client";
import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { keptForgeLimit, persistQueries, queryRecordKey } from "./query-persistence.ts";

const host = "6b0f9c1e-1f5c-4b5e-9d0a-2f8f6a3c7d11";

function memory() {
  const values = new Map<string, unknown>();
  const storage: ReadSnapshotStorage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
  return { values, storage };
}

function timers() {
  const jobs = new Set<{ delayMs: number; run: () => void }>();
  return {
    schedule(delayMs: number, run: () => void) {
      const job = { delayMs, run };
      jobs.add(job);
      return () => {
        jobs.delete(job);
      };
    },
    flush() {
      for (const job of jobs) {
        jobs.delete(job);
        job.run();
      }
    },
  };
}

function session(
  storage: ReadSnapshotStorage,
  options: { build?: string; hostId?: string; writable?: () => boolean } = {},
) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const time = timers();
  const stop = persistQueries({
    queries,
    storage,
    build: options.build ?? "build-1",
    hostId: options.hostId ?? host,
    writable: options.writable ?? (() => true),
    schedule: time.schedule,
  });
  return { queries, time, stop };
}

/** What a view reading `key` sees first, and after it asks the daemon again. */
async function observe(queries: QueryClient, key: QueryKey, answer: unknown) {
  const observer = new QueryObserver(queries, {
    queryKey: key,
    queryFn: async () => answer,
    // The model catalog, host identity and others never go stale on their own.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const first = observer.getCurrentResult().data;
  const seen: unknown[] = [];
  const stop = observer.subscribe((result) => seen.push(result.data));
  await vi.waitFor(() => expect(seen.at(-1)).toEqual(answer), { timeout: 5_000 });
  stop();
  return first;
}

test("lookups kept by an earlier session show at once and are asked for again", async () => {
  const m = memory();
  const earlier = session(m.storage);
  await earlier.queries.fetchQuery({ queryKey: ["projects"], queryFn: async () => ["ace"] });
  await earlier.queries.fetchQuery({ queryKey: ["models", "list"], queryFn: async () => ["m1"] });
  earlier.time.flush();
  await vi.waitFor(() => expect(m.values.has(queryRecordKey)).toBe(true));
  earlier.stop();

  const next = session(m.storage);
  await vi.waitFor(() => expect(next.queries.getQueryData(["projects"])).toEqual(["ace"]));
  expect(await observe(next.queries, ["projects"], ["ace", "web"])).toEqual(["ace"]);
  expect(await observe(next.queries, ["models", "list"], ["m2"])).toEqual(["m1"]);
  next.stop();
});

test("only lookups worth keeping are written: file contents, diffs and searches never are", async () => {
  const m = memory();
  const s = session(m.storage);
  await s.queries.fetchQuery({ queryKey: ["projects"], queryFn: async () => ["ace"] });
  for (const key of [
    ["checkout", "file", "thread", "src/secret.ts", 0],
    ["working-tree-diff", "thread", "clean", "main", "abc"],
    ["search", "words", "all", {}, 1],
    ["projects", "folders", "primary", "home"],
  ])
    await s.queries.fetchQuery({ queryKey: key, queryFn: async () => "contents" });
  s.time.flush();
  await vi.waitFor(() => expect(m.values.has(queryRecordKey)).toBe(true));
  expect(JSON.stringify(m.values.get(queryRecordKey))).not.toContain("contents");
  expect(m.values.get(queryRecordKey)).toMatchObject({
    queries: [{ key: ["projects"], data: ["ace"] }],
  });
  s.stop();
});

test.each([
  { name: "another build", options: { build: "build-2" } },
  { name: "a daemon started afresh at the same address", options: { hostId: "another-host" } },
])("a record from $name is never shown", async ({ options }) => {
  const m = memory();
  const earlier = session(m.storage);
  await earlier.queries.fetchQuery({ queryKey: ["projects"], queryFn: async () => ["old"] });
  earlier.time.flush();
  await vi.waitFor(() => expect(m.values.has(queryRecordKey)).toBe(true));
  earlier.stop();

  const next = session(m.storage, options);
  expect(await observe(next.queries, ["projects"], ["new"])).toBeUndefined();
  next.stop();
});

test("a kept record never replaces what the daemon has already answered", async () => {
  const m = memory();
  const earlier = session(m.storage);
  await earlier.queries.fetchQuery({ queryKey: ["projects"], queryFn: async () => ["old"] });
  earlier.time.flush();
  await vi.waitFor(() => expect(m.values.has(queryRecordKey)).toBe(true));
  earlier.stop();

  let release: (() => void) | undefined;
  const slow: ReadSnapshotStorage = {
    get: (key) =>
      new Promise((resolve) => {
        release = () => resolve(m.values.get(key));
      }),
    set: m.storage.set,
  };
  const next = session(slow);
  await next.queries.fetchQuery({ queryKey: ["projects"], queryFn: async () => ["live"] });
  release?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(next.queries.getQueryData(["projects"])).toEqual(["live"]);
  next.stop();
});

test("a PR panel's reads are kept without provider payloads and never crowd out the app's lookups", async () => {
  const m = memory();
  const s = session(m.storage);
  const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" };
  const last = keptForgeLimit + 6;
  await s.queries.fetchQuery({ queryKey: ["projects"], queryFn: async () => ["ace"] });
  for (let number = 1; number <= last; number++)
    await s.queries.fetchQuery({
      queryKey: ["forge", "api", undefined, "pr", number],
      queryFn: async () => ({ title: `PR ${number}`, status: { raw: { token: "payload" } } }),
    });
  await s.queries.fetchQuery({
    queryKey: ["forge", "api", { repository, number: 1 }, "file-pages", "b", "h", ""],
    queryFn: async () => "diff contents",
  });
  s.time.flush();
  await vi.waitFor(() => expect(m.values.has(queryRecordKey)).toBe(true), { timeout: 5_000 });
  const text = JSON.stringify(m.values.get(queryRecordKey));
  expect(text).not.toContain("payload");
  expect(text).not.toContain("diff contents");
  expect(text).toContain('"projects"');
  expect(text.match(/"title":"PR \d+"/g)).toHaveLength(keptForgeLimit);
  s.stop();

  const next = session(m.storage);
  const key = ["forge", "api", undefined, "pr", last];
  await vi.waitFor(() => expect(next.queries.getQueryData(key)).toBeDefined(), {
    timeout: 5_000,
  });
  // Shown as kept first, then replaced by what the daemon says now.
  expect(await observe(next.queries, key, { title: "PR now", status: {} })).toMatchObject({
    title: `PR ${last}`,
  });
  next.stop();
});

test("nothing is written while the connection is down or after the app let go", async () => {
  const m = memory();
  let up = false;
  const s = session(m.storage, { writable: () => up });
  await s.queries.fetchQuery({ queryKey: ["projects"], queryFn: async () => ["ace"] });
  s.time.flush();
  await Promise.resolve();
  expect(m.values.has(queryRecordKey)).toBe(false);
  up = true;
  await s.queries.fetchQuery({
    queryKey: ["skills"],
    queryFn: async () => ["skill"],
  });
  s.stop();
  s.time.flush();
  await Promise.resolve();
  expect(m.values.has(queryRecordKey)).toBe(false);
});
