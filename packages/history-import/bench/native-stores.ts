import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { openHistory } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "ace-native-store-bench-"));
let service;
try {
  const databaseHome = join(root, "database"),
    storageHome = join(root, "storage");
  await mkdir(databaseHome);
  const db = new DatabaseSync(join(databaseHome, "opencode.db"));
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX message_order ON message(session_id,time_created,id);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT);
    CREATE INDEX part_message ON part(message_id,id);
    INSERT INTO session VALUES('database','/database','database',0,NULL);BEGIN`);
  const message = db.prepare("INSERT INTO message VALUES(?,?,?,?)"),
    part = db.prepare("INSERT INTO part VALUES(?,?,?)");
  for (let i = 0; i < 5000; i++) {
    message.run(String(i), "database", i, JSON.stringify({ role: "user", time: { created: i } }));
    part.run(String(i), String(i), JSON.stringify({ type: "text", text: "x".repeat(512) }));
  }
  db.exec("COMMIT");
  db.close();
  const sessionDir = join(storageHome, "storage/session/project"),
    messagesDir = join(storageHome, "storage/message/legacy");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(messagesDir, { recursive: true });
  await writeFile(
    join(sessionDir, "legacy.json"),
    JSON.stringify({ id: "legacy", directory: "/legacy", title: "legacy", time: { updated: 0 } }),
  );
  for (let start = 0; start < 1000; start += 16)
    await Promise.all(
      Array.from({ length: Math.min(16, 1000 - start) }, async (_, offset) => {
        const n = start + offset,
          id = String(n).padStart(6, "0");
        const parts = join(storageHome, "storage/part", id);
        await mkdir(parts, { recursive: true });
        await writeFile(
          join(messagesDir, id + ".json"),
          JSON.stringify({ id, role: "user", time: { created: 1000 - n } }),
        );
        await writeFile(
          join(parts, "part.json"),
          JSON.stringify({ type: "text", text: "x".repeat(512) }),
        );
      }),
    );
  service = await openHistory({
    indexPath: join(root, "ace/index.sqlite"),
    instances: [
      { id: "database", provider: "opencode", homeDir: databaseHome },
      { id: "legacy", provider: "opencode", homeDir: storageHome },
    ],
  });
  for (const state of ["cold", "warm"]) {
    const started = performance.now();
    const result = await service.scan();
    console.log(
      JSON.stringify({
        benchmark: `native-store-${state}-index`,
        ms: performance.now() - started,
        ...result,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  }
  for (const [cwd, count] of [
    ["/database", 5000],
    ["/legacy", 1000],
  ] satisfies [string, number][]) {
    const source = (await service.list({ type: "history.list", cwd })).sessions[0];
    if (!source) throw new Error("Missing source");
    const started = performance.now();
    const imported = await service.importSession({
      sourceId: source.id,
      threadId: ThreadId.parse(cwd),
      workspaceId: WorkspaceId.parse("bench"),
      agentId: cwd,
      at: 0,
    });
    const ms = performance.now() - started;
    console.log(
      JSON.stringify({
        benchmark:
          cwd === "/database" ? "5000-sqlite-message-import" : "1000-storage-message-order-import",
        ms,
        messagesPerSecond: count / (ms / 1000),
        ...imported,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  }
} finally {
  await service?.close();
  await rm(root, { recursive: true, force: true });
}
