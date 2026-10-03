import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startDaemon, readConfig } from "@ace/daemon";
import { Client, webSocketTransport } from "./index.ts";
import { ManualScheduler, memoryStorage, ready, when } from "./test-support.ts";
import { DeviceId, type HistoryOperationProgress } from "@ace/protocol";

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
    const workspaceId = daemon.store.createWorkspace("/history", "History");
    const source = list.sessions[0];
    if (!source) throw new Error("Missing native history");
    const progress: HistoryOperationProgress[] = [];
    const stop = client.onMessage((message) => {
      if (message.type === "history.operation.progress") progress.push(message);
    });
    const imported = await client.request(
      { type: "history.import", sourceId: source.id, workspaceId },
      { requestId: "import-native" },
    );
    expect(imported).toMatchObject({
      type: "history.import",
      requestId: "import-native",
      status: "imported",
    });
    expect(
      progress.filter((event) => event.requestId === "import-native").map((event) => event.phase),
    ).toEqual(["preparing", "reading", "publishing", "completed"]);
    if (imported.status !== "imported") throw new Error("Expected imported thread");
    const history = await client.itemsPage({ threadId: imported.threadId, limit: 20 });
    expect(
      history.items.some(
        (item) =>
          item.type === "message" &&
          item.parts.some((part) => part.type === "text" && part.text === "cached prompt"),
      ),
    ).toBe(true);
    const continued = await client.request(
      {
        type: "history.continue",
        threadId: imported.threadId,
        mode: "resume",
        input: [{ type: "text", text: "Do not launch a CLI" }],
      },
      { requestId: "continue-native" },
    );
    expect(continued).toMatchObject({
      type: "history.continue",
      requestId: "continue-native",
      status: "unsupported",
    });
    expect(
      progress.filter((event) => event.requestId === "continue-native").map((event) => event.phase),
    ).toEqual(["preparing", "unsupported"]);
    await expect(
      client.request(
        { type: "history.import", sourceId: "missing", workspaceId },
        { requestId: "missing-native" },
      ),
    ).rejects.toMatchObject({ code: "daemon", message: "history_rejected" });
    expect(
      progress.filter((event) => event.requestId === "missing-native").map((event) => event.phase),
    ).toEqual(["preparing", "failed"]);
    stop();
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
