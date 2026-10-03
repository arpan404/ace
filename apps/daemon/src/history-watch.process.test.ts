import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { openDaemonHistory } from "./history.ts";

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
    const refreshed = Promise.withResolvers<void>();
    const unsubscribe = history.subscribeScan((status) => {
      if (status.state === "ready") refreshed.resolve();
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
