import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "@ace/diagnostics";
import { Store } from "./store.ts";
import { openDaemonHistory } from "./history.ts";

test("one scan groups repeated unreadable-history warnings by account and reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-history-log-"));
  const home = join(root, "provider");
  const directory = join(home, "projects/p");
  await mkdir(directory, { recursive: true });
  for (let i = 0; i < 4; i++)
    await writeFile(
      join(directory, `${i}.jsonl`),
      JSON.stringify({
        type: "user",
        sessionId: `s${i}`,
        cwd: "/repo",
        message: { role: "user", content: "x".repeat(2 * 1024 * 1024) },
      }) + "\n",
    );
  const records: unknown[] = [];
  const log = createLogger({
    now: () => 1,
    redact: (line) => line,
    sink: {
      async write(batch) {
        records.push(...batch);
      },
      async close() {},
    },
  });
  const store = new Store(join(root, "events.sqlite"));
  const history = await openDaemonHistory(root, store, {
    instances: [{ id: "account", provider: "claude", homeDir: home }],
    log,
    historyRuntime: { watch: () => () => {} },
  });
  try {
    await history.startScan();
    expect(history.scanStatus().unsupported).toHaveLength(4);
    await log.close();
    expect(records).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "Saved history could not be read",
        data: expect.objectContaining({ instanceId: "account", count: 4 }),
      }),
    ]);
  } finally {
    await history.close();
    await store.close();
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});
