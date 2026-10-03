import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startDaemon, readConfig } from "@ace/daemon";
import { Client, webSocketTransport } from "./index.ts";
import { ManualScheduler, memoryStorage, ready, when } from "./test-support.ts";
import { DeviceId } from "@ace/protocol";

test("history client correlates list and scan requests and observes indexing completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-client-history-"));
  const home = join(root, "native");
  await mkdir(join(home, "projects/p"), { recursive: true });
  await writeFile(
    join(home, "projects/p/session.jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: "native",
      cwd: "/history",
      message: { content: "cached prompt" },
    }) + "\n",
  );
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: join(root, "ace"), ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    handler: { handle: (command) => ({ commandId: command.id, ok: false, error: "unused" }) },
    history: { instances: [{ id: "account", provider: "claude", homeDir: home }] },
  });
  let seq = 0;
  const client = new Client({
    transport: () => webSocketTransport(() => new WebSocket(daemon.url)),
    scheduler: new ManualScheduler(),
    storage: memoryStorage(),
    credential: async () => readFile(daemon.tokenPath, "utf8"),
    id: () => `history-${++seq}`,
    random: () => 0.5,
    deviceId: DeviceId.parse("history-client"),
  });
  try {
    await daemon.history?.startScan();
    await ready(client);
    const [list, status] = await Promise.all([
      client.listHistory({ cwd: "/history" }),
      client.historyScanStatus(),
    ]);
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]?.title).toBe("cached prompt");
    expect(status.scan?.state).toBe("ready");
    expect(client.historyScan().getSnapshot()?.state).toBe("ready");
    const scan = await client.scanHistory();
    expect(scan.scan?.state).toBe("scanning");
    const finished = await when(client.historyScan(), (value) => value?.state === "ready");
    expect(finished?.stats).toMatchObject({ files: 1, reads: 0, skipped: 1 });
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
