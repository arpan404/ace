import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { openDaemonHistory } from "./history.ts";

const noop = () => {};

test("observed transcript changes refresh daemon history without a client requesting another scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-daemon-history-watch-"));
  const home = join(root, "claude");
  const directory = join(home, "projects/p");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "native.jsonl");
  await writeFile(
    path,
    JSON.stringify({
      type: "user",
      sessionId: "native",
      cwd: "/project",
      message: { role: "user", content: "before" },
    }) + "\n",
  );
  const store = new Store(join(root, "events.sqlite"));
  const history = await openDaemonHistory(root, store, {
    instances: [{ id: "account", provider: "claude", homeDir: home }],
  });
  try {
    await history.startScan();
    const initial = await history.handle(
      { type: "history.list", cwd: "/project", limit: 10 },
      new AbortController().signal,
    );
    if (initial.type !== "history.list") throw new Error("Wrong history reply");
    expect(initial.sessions[0]?.title).toBe("before");
    const refreshed = Promise.withResolvers<void>();
    const unsubscribe = history.subscribeScan((status) => {
      if (status.state !== "ready") return;
      void history
        .handle({ type: "history.list", cwd: "/project", limit: 10 }, new AbortController().signal)
        .then((result) => {
          if (result.type === "history.list" && result.sessions[0]?.title === "after")
            refreshed.resolve();
        }, refreshed.reject);
    });
    try {
      await appendFile(
        path,
        JSON.stringify({ type: "ai-title", sessionId: "native", aiTitle: "after" }) + "\n",
      );
      await refreshed.promise;
      const result = await history.handle(
        { type: "history.list", cwd: "/project", limit: 10 },
        new AbortController().signal,
      );
      if (result.type !== "history.list") throw new Error("Wrong history reply");
      expect(result.sessions[0]?.title).toBe("after");
    } finally {
      unsubscribe();
    }
  } finally {
    await history.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bursty native writes wait for a throttled scan and leave no work scheduled once settled", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-daemon-history-throttle-"));
  const home = join(root, "claude");
  const path = join(home, "projects/p/native.jsonl");
  await mkdir(join(home, "projects/p"), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      type: "user",
      sessionId: "native",
      cwd: "/project",
      message: { role: "user", content: "before" },
    }) + "\n",
  );
  const store = new Store(join(root, "events.sqlite"));
  let changed: (event: "rename" | "change", filename: string | null) => void = noop;
  let scheduled: { run: () => void; milliseconds: number } | undefined;
  let now = 0;
  const history = await openDaemonHistory(root, store, {
    instances: [{ id: "account", provider: "claude", homeDir: home }],
    now: () => now,
    historyRuntime: {
      watch: (_path, callback) => {
        changed = callback;
        return () => {};
      },
    },
    scheduleScan(run, milliseconds) {
      const task = { run, milliseconds };
      scheduled = task;
      return () => {
        if (scheduled === task) scheduled = undefined;
      };
    },
  });
  const list = async () => {
    const result = await history.handle(
      { type: "history.list", cwd: "/project", limit: 10 },
      new AbortController().signal,
    );
    if (result.type !== "history.list") throw new Error("Wrong history reply");
    return result.sessions[0]?.title;
  };
  const drain = async () => {
    const ready = Promise.withResolvers<void>();
    const stop = history.subscribeScan((status) => {
      if (status.state === "ready") ready.resolve();
    });
    try {
      const task = scheduled;
      if (!task) throw new Error("Missing scan deadline");
      scheduled = undefined;
      now += task.milliseconds;
      task.run();
      await ready.promise;
      // startScan joins the current scan, including its settlement cleanup.
      await history.startScan();
    } finally {
      stop();
    }
  };
  try {
    await history.startScan();
    await appendFile(
      path,
      JSON.stringify({ type: "ai-title", sessionId: "native", aiTitle: "batched" }) + "\n",
    );
    for (let index = 0; index < 100; index++) changed("change", "projects/p/native.jsonl");
    expect(await list()).toBe("before");
    expect(scheduled?.milliseconds).toBe(1000);
    await drain();
    expect(await list()).toBe("batched");
    expect(scheduled).toBeUndefined();
    await appendFile(
      path,
      JSON.stringify({ type: "ai-title", sessionId: "native", aiTitle: "second" }) + "\n",
    );
    changed("change", "projects/p/native.jsonl");
    expect(await list()).toBe("batched");
    expect(scheduled?.milliseconds).toBe(5000);
    await drain();
    expect(await list()).toBe("second");
    expect(scheduled).toBeUndefined();
    changed("change", "projects/p/native.jsonl");
    await history.close();
    expect(scheduled).toBeUndefined();
  } finally {
    await history.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
