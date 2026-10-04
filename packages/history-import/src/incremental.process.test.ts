import { join } from "node:path";
import { unlink, appendFile, rename } from "node:fs/promises";
import { expect, test } from "vitest";
import { environment, jsonl, claudeRecords, cwd } from "./test-support.ts";
import { openHistory, type HistoryService, type HistoryRuntime } from "./index.ts";
import { Worker } from "node:worker_threads";
import { once } from "node:events";

const noop = () => {};
function watchBoundary() {
  let deliver: (event: "rename" | "change", path: string | null) => void = noop;
  const watch: NonNullable<HistoryRuntime["watch"]> = (_path, changed) => {
    deliver = changed;
    return () => {
      deliver = noop;
    };
  };
  return { watch, change: (path: string) => deliver("change", path) };
}

async function observedUpdate(
  service: HistoryService,
  mutate: () => Promise<void>,
  visible: (response: Awaited<ReturnType<HistoryService["list"]>>) => boolean,
) {
  let changed = Promise.withResolvers<void>();
  const stop = service.subscribeChanges(() => changed.resolve());
  try {
    await mutate();
    for (;;) {
      await changed.promise;
      // Earlier startup notifications may arrive alongside the mutation. Keep
      // waiting on real native events until the requested public result is visible.
      changed = Promise.withResolvers<void>();
      const result = await service.scanChanges();
      const listed = await service.list({ type: "history.list", cwd, limit: 10 });
      if (visible(listed)) return result;
    }
  } finally {
    stop();
  }
}

test("a changed transcript and a deletion refresh without dropping unrelated cached sessions", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  const first = join(home, "projects/p/first.jsonl"),
    second = join(home, "projects/p/second.jsonl");
  const homes = [{ id: "account", provider: "claude" as const, homeDir: home }];
  try {
    await jsonl(first, claudeRecords("first", "first"));
    await jsonl(second, claudeRecords("second", "second"));
    const service = await env.start(homes);
    await service.scan();
    const update = await observedUpdate(
      service,
      () =>
        appendFile(
          first,
          JSON.stringify({ type: "ai-title", sessionId: "first", aiTitle: "later" }) + "\n",
        ),
      (result) =>
        result.sessions.some(
          (session) => session.nativeId === "first" && session.title === "later",
        ),
    );
    expect(update.reads).toBe(1);
    const listed = await service.list({ type: "history.list", cwd, limit: 10 });
    expect(listed.sessions.map((session) => session.nativeId).toSorted()).toEqual([
      "first",
      "second",
    ]);
    expect(listed.sessions.find((session) => session.nativeId === "first")?.title).toBe("later");
    await observedUpdate(
      service,
      () => unlink(first),
      (result) => !result.sessions.some((session) => session.nativeId === "first"),
    );
    expect(
      (await service.list({ type: "history.list", cwd, limit: 10 })).sessions.map(
        (session) => session.nativeId,
      ),
    ).toEqual(["second"]);
    await service.close();
    // No filesystem event was observed while closed. Restart must not trust a directory mtime.
    await appendFile(
      second,
      JSON.stringify({ type: "ai-title", sessionId: "second", aiTitle: "offline" }) + "\n",
    );
    const restarted = await env.start(homes);
    await restarted.scan();
    expect(
      (await restarted.list({ type: "history.list", cwd, limit: 10 })).sessions[0]?.title,
    ).toBe("offline");
  } finally {
    await env.close();
  }
});

test("watch overflow falls back to inventory verification without retaining every changed path", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  const source = watchBoundary();
  try {
    await jsonl(join(home, "projects/p/retained.jsonl"), claudeRecords("retained", "retained"));
    const service = await env.start([{ id: "account", provider: "claude", homeDir: home }], {
      watch: source.watch,
    });
    await service.scanChanges();
    // Native watch callbacks can be coalesced arbitrarily. Inject that boundary,
    // not a count of callbacks from 4,100 actual filesystem writes.
    for (let index = 0; index < 4100; index++) source.change(`projects/p/noise-${index}.tmp`);
    // None are transcripts. Only the overflow fallback verifies the unchanged
    // source; an unbounded dirty batch would visit zero transcripts.
    expect(await service.scanChanges()).toMatchObject({ files: 1, reads: 0, skipped: 1 });
    expect((await service.list({ type: "history.list", cwd })).sessions[0]?.title).toBe("retained");
    expect(await service.scanChanges()).toMatchObject({ files: 0, reads: 0 });
  } finally {
    await env.close();
  }
});

test("a renamed transcript removes the old source while preserving its native session", async () => {
  const env = await environment();
  const home = join(env.root, "claude"),
    directory = join(home, "projects/p");
  try {
    await jsonl(join(directory, "old.jsonl"), claudeRecords("same", "native"));
    const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
    await service.scanChanges();
    const previous = (await service.list({ type: "history.list", cwd })).sessions[0];
    if (!previous) throw new Error("Missing source");
    const observed = Promise.withResolvers<void>();
    const stop = service.subscribeChanges(() => observed.resolve());
    try {
      await rename(join(directory, "old.jsonl"), join(directory, "new.jsonl"));
      await observed.promise;
      await service.scanChanges();
      const sessions = (await service.list({ type: "history.list", cwd })).sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.nativeId).toBe("native");
      expect(await service.get(previous.id)).toBeNull();
    } finally {
      stop();
    }
  } finally {
    await env.close();
  }
});

test("a subscriber observes already dirty history after the idle worker exits and reopens", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  const path = join(home, "projects/p/first.jsonl");
  const source = watchBoundary();
  let retire: (() => void) | undefined;
  let firstExit: Promise<unknown> | undefined;
  let service: HistoryService | undefined;
  try {
    await jsonl(path, claudeRecords("before", "first"));
    service = await openHistory(
      {
        indexPath: join(env.root, "ace/index.sqlite"),
        instances: [{ id: "account", provider: "claude", homeDir: home }],
      },
      (url, options) => {
        const worker = new Worker(url, options);
        firstExit ??= once(worker, "exit");
        return worker;
      },
      {
        watch: source.watch,
        delay(callback) {
          retire = callback;
          return () => {
            if (retire === callback) retire = undefined;
          };
        },
      },
    );
    await service.scanChanges();
    source.change("projects/p/first.jsonl");
    await service.scan();
    expect(await service.scanChanges()).toMatchObject({ files: 0, reads: 0 });
    if (!retire || !firstExit) throw new Error("No settled worker to retire");
    retire();
    await firstExit;
    await appendFile(
      path,
      JSON.stringify({ type: "ai-title", sessionId: "first", aiTitle: "after retirement" }) + "\n",
    );
    // The only event precedes the subscription. No later event can rescue a lost wakeup.
    source.change("projects/p/first.jsonl");
    const changed = Promise.withResolvers<void>();
    const stop = service.subscribeChanges(() => changed.resolve());
    try {
      await changed.promise;
      expect(await service.scanChanges()).toMatchObject({ files: 1, reads: 1 });
      expect((await service.list({ type: "history.list", cwd })).sessions[0]?.title).toBe(
        "after retirement",
      );
    } finally {
      stop();
    }
    await service.close();
    await service.close();
  } finally {
    await service?.close();
    await env.close();
  }
});

test("closing a scan drains cancellation while its progress observer is held and ignores its late completion", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  try {
    await jsonl(join(home, "projects/p/first.jsonl"), claudeRecords("first", "first"));
    const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
    const scanning = service.scanChanges(undefined, async () => {
      entered.resolve();
      await release.promise;
      finished.resolve();
    });
    const rejected = expect(scanning).rejects.toThrow();
    await entered.promise;
    await service.close();
    await rejected;
    release.resolve();
    await finished.promise;
    await expect(service.list({ type: "history.list", cwd })).rejects.toThrow("closed");
    await service.close();
  } finally {
    release.resolve();
    await env.close();
  }
});
