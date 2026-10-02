import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { DeviceId, ServerMessage, type ClientMessage, type ContextOperation } from "@ace/protocol";
import { startDaemon, readConfig, createDevThread } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "ace-context-wire-bench-"));
const daemon = await startDaemon(
  readConfig({ ACE_HOME: root, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
);
const socket = new WebSocket(daemon.url);
try {
  await once(socket, "open");
  const exchange = async (message: ClientMessage) => {
    const next = once(socket, "message");
    socket.send(JSON.stringify(message));
    return ServerMessage.parse(JSON.parse(String((await next)[0])));
  };
  await exchange({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("benchmark"),
    token: await readFile(daemon.tokenPath, "utf8"),
  });
  const workspace = daemon.store.createWorkspace(root, "Benchmark"),
    thread = createDevThread(daemon.store, workspace);
  let request = 0;
  const context = async (operation: ContextOperation) => {
    const result = await exchange({
      type: "context.request",
      requestId: `request-${++request}`,
      operation,
    });
    if (result.type !== "context.result" || result.result.kind === "error")
      throw new Error(JSON.stringify(result));
    return result.result;
  };
  const chunk = Buffer.alloc(64 * 1024, 97),
    data = chunk.toString("base64"),
    total = 16 * 1024 * 1024;
  const digest = createHash("sha256");
  for (let i = 0; i < total; i += chunk.length) digest.update(chunk);
  const start = performance.now();
  const begin = await context({
    op: "upload.begin",
    threadId: thread.id,
    bytes: total,
    sha256: digest.digest("hex"),
    name: "wire-benchmark.txt",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  for (let offset = 0; offset < total; offset += chunk.length)
    await context({ op: "upload.chunk", uploadId: begin.uploadId, offset, data });
  await context({ op: "upload.commit", uploadId: begin.uploadId });
  console.log(
    JSON.stringify(
      {
        transport: "loopback WebSocket, JSON/base64, 64 KiB chunks, durable acknowledgments",
        MiBs: 16 / ((performance.now() - start) / 1000),
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      },
      null,
      2,
    ),
  );
} finally {
  const closed = once(socket, "close");
  socket.close();
  await closed;
  await daemon.close();
  await rm(root, { recursive: true, force: true });
}
