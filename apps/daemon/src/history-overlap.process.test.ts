import { expect, test } from "vitest";
import { join } from "node:path";
import { openHistory } from "@ace/history-import";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "./store.ts";
import { DaemonHistory } from "./history.ts";
import { z } from "zod";
import { createLogger } from "@ace/diagnostics";

const cwd = "/synthetic";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-history-overlap-")),
    data = join(root, "ace"),
    home = join(root, "claude");
  await mkdir(join(home, "projects/p"), { recursive: true });
  await writeFile(
    join(home, "projects/p/a.jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: "saved",
      cwd,
      message: { role: "user", content: "hello" },
    }) + "\n",
  );
  return { root, data, home, close: () => rm(root, { recursive: true, force: true }) };
}

test("a scan overlapping an in-flight list keeps reporting scanning and publishes readable sessions", async () => {
  const env = await fixture(),
    { data, home } = env;
  const instances = [{ id: "claude", provider: "claude" as const, homeDir: home }];
  const service = await openHistory({ indexPath: join(data, "index.sqlite"), instances });
  const store = new Store(join(data, "events.sqlite"));
  const history = new DaemonHistory(store, service, data, join(data, "index.sqlite"), {
    instances,
  });
  try {
    const listing = history.handle(
      { type: "history.list", cwd, limit: 10 },
      new AbortController().signal,
    );
    const scan = history.startScan();
    expect(history.scanStatus().state).toBe("scanning");
    expect(await listing).toMatchObject({ type: "history.list", scan: { state: "scanning" } });
    await scan;
    expect(history.scanStatus().state).toBe("ready");
    expect(
      await history.handle({ type: "history.list", cwd, limit: 10 }, new AbortController().signal),
    ).toMatchObject({ sessions: [expect.objectContaining({ title: "hello" })] });
  } finally {
    await history.close();
    await store.close();
    await env.close();
  }
});

test("scan failures leave a useful diagnostic instead of failing silently", async () => {
  const env = await fixture(),
    { data, home } = env;
  const instances = [{ id: "claude", provider: "claude" as const, homeDir: home }];
  const service = await openHistory({ indexPath: join(data, "index.sqlite"), instances });
  const store = new Store(join(data, "events.sqlite"));
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 10,
    redact: (line) => line,
  });
  const history = new DaemonHistory(store, service, data, join(data, "index.sqlite"), {
    instances,
    log: log.child("history"),
  });
  try {
    await service.close();
    await history.startScan();
    expect(history.scanStatus().state).toBe("failed");
    expect(
      log
        .recent()
        .map((line) =>
          z
            .object({ level: z.string(), message: z.string(), data: z.unknown() })
            .parse(JSON.parse(line)),
        ),
    ).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Past sessions scan failed",
        data: expect.objectContaining({ message: expect.stringContaining("closed") }),
      }),
    );
  } finally {
    await history.close();
    await log.close();
    await store.close();
    await env.close();
  }
});
