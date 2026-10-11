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
  const failures: string[] = [];
  const history = new DaemonHistory(store, service, data, join(data, "index.sqlite"), {
    instances,
    log: log.child("history"),
    onError(_error, operation) {
      failures.push(operation);
    },
  });
  try {
    await service.close();
    await history.startScan();
    expect(history.scanStatus().state).toBe("failed");
    expect(failures).toEqual(["history.scan"]);
    await expect(
      history.handle({ type: "history.list", cwd, limit: 10 }, new AbortController().signal),
    ).rejects.toThrow();
    expect(failures).toEqual(["history.scan", "history.list"]);
    expect(log.recent().filter((line) => line.includes('"operation":"history.scan"'))).toHaveLength(
      1,
    );
    expect(log.recent().filter((line) => line.includes('"operation":"history.list"'))).toHaveLength(
      1,
    );
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
        level: "warn",
        message: "Past sessions operation failed",
        data: expect.objectContaining({
          operation: "history.scan",
          error: expect.objectContaining({ message: expect.stringContaining("closed") }),
        }),
      }),
    );
  } finally {
    await history.close();
    await log.close();
    await store.close();
    await env.close();
  }
});

test("starting a scan while an import owns persistence returns the current scan status", async () => {
  const env = await fixture();
  const instances = [{ id: "claude", provider: "claude" as const, homeDir: env.home }];
  const service = await openHistory({ indexPath: join(env.data, "index.sqlite"), instances });
  const store = new Store(join(env.data, "events.sqlite"));
  const paused = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const history = new DaemonHistory(store, service, env.data, join(env.data, "index.sqlite"), {
    instances,
    adapters: {
      resolve: () => undefined,
      onFrame: () => {},
      onExit: () => {},
      async pausePersistence() {
        paused.resolve();
        await release.promise;
        return async () => {
          await Promise.resolve();
        };
      },
    },
  });
  try {
    await history.startScan();
    const listed = await history.handle(
      { type: "history.list", cwd, limit: 10 },
      new AbortController().signal,
    );
    if (listed.type !== "history.list" || !listed.sessions[0]) throw Error("No fixture session");
    const workspaceId = store.createWorkspace(cwd, "Fixture");
    const importing = history.handle(
      { type: "history.import", sourceId: listed.sessions[0].id, workspaceId },
      new AbortController().signal,
    );
    await paused.promise;
    expect(
      await history.handle({ type: "history.scan", action: "start" }, new AbortController().signal),
    ).toMatchObject({ type: "history.scan", scan: { state: "ready" } });
    release.resolve();
    expect(await importing).toMatchObject({ type: "history.import", status: "imported" });
  } finally {
    release.resolve();
    await history.close();
    await store.close();
    await env.close();
  }
});
