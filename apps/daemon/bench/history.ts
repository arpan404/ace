import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createWriteStream, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DeviceId } from "@ace/protocol";
import { startDaemon, readConfig } from "../src/index.ts";
import { Client } from "../src/socket-test-support.ts";

const root = await mkdtemp(join(tmpdir(), "ace-history-publish-bench-"));
let daemon, client;
try {
  const home = join(root, "claude");
  await mkdir(join(home, "projects/p"), { recursive: true });
  const stream = createWriteStream(join(home, "projects/p/session.jsonl"));
  for (let i = 0; i < 20000; i++) {
    const record = {
      type: "user",
      sessionId: "session",
      cwd: "/bench",
      uuid: `node-${i}`,
      parentUuid: i ? `node-${i - 1}` : null,
      message: { role: "user", content: "x".repeat(512) },
    };
    if (!stream.write(JSON.stringify(record) + "\n")) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
  daemon = await startDaemon({
    config: readConfig({ ACE_HOME: join(root, "ace"), ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    toolkits: [],
    notificationChannels: {},
    modelInstances: [],
    history: { instances: [{ id: "account", provider: "claude", homeDir: home }] },
  });
  client = new Client(daemon.url);
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("bench"),
    token: readFileSync(daemon.tokenPath, "utf8"),
  });
  await client.next();
  client.send({ type: "history.list", cwd: "/bench", limit: 50 });
  const list = await client.next();
  if (list.type !== "history.list" || !list.sessions[0]) throw new Error("Missing history");
  const workspaceId = daemon.store.createWorkspace("/bench", "Bench");
  const start = performance.now();
  client.send({ type: "history.import", sourceId: list.sessions[0].id, workspaceId });
  const result = await client.next();
  if (result.type !== "history.import" || result.status !== "imported")
    throw new Error("Import failed");
  const ms = performance.now() - start;
  console.log(
    JSON.stringify({
      benchmark: "20000-ancestry-and-daemon-publication",
      ms,
      messagesPerSecond: 20000 / (ms / 1000),
      events: daemon.store.headSeq(),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
} finally {
  await client?.close();
  await daemon?.close();
  await rm(root, { recursive: true, force: true });
}
