import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { FilesServerMessage, ServerMessage } from "@ace/protocol";
import { decodeFileFrame } from "@ace/files";
import { startDaemon } from "./index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
function parseControl(input: unknown) {
  const standard = ServerMessage.safeParse(input);
  return standard.success ? standard.data : FilesServerMessage.parse(input);
}
class Inbox {
  readonly socket: WebSocket;
  private queue: unknown[] = [];
  private waiters: ((message: unknown) => void)[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data, binary) => {
      const message = binary
        ? z.instanceof(Buffer).parse(data)
        : parseControl(JSON.parse(data.toString()));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }
  next(): Promise<unknown> {
    const next = this.queue.shift();
    return next === undefined
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve(next);
  }
  send(input: unknown) {
    this.socket.send(JSON.stringify(input));
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const ended = once(this.socket, "close");
    this.socket.close();
    await ended;
  }
}
it("serves binary files on the authenticated daemon socket alongside normal commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-files-daemon-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "workspace");
  await mkdir(root);
  await writeFile(join(root, "binary"), Buffer.from([0, 255, 17]));
  const daemon = await startDaemon({
    dataDir: join(home, "data"),
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
  });
  cleanup.push(() => daemon.close());
  const client = new Inbox(daemon.url);
  cleanup.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: "phone",
    token: (await readFile(daemon.tokenPath, "utf8")).trim(),
  });
  expect(await client.next()).toMatchObject({ type: "welcome" });
  client.send({
    type: "files.request",
    requestId: "file",
    operation: { op: "download", path: "binary" },
  });
  const ready = z
    .object({ type: z.literal("files.ready"), channel: z.number() })
    .parse(await client.next());
  client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  expect(decodeFileFrame(z.instanceof(Buffer).parse(await client.next())).bytes).toEqual(
    Buffer.from([0, 255, 17]),
  );
  expect(await client.next()).toMatchObject({ type: "files.end" });
  client.send({ type: "ping" });
  expect(await client.next()).toEqual({ type: "pong" });
});
it("rejects file requests before authentication", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-files-auth-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const daemon = await startDaemon({
    dataDir: home,
    workspaceRoot: home,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
  });
  cleanup.push(() => daemon.close());
  const client = new Inbox(daemon.url);
  cleanup.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "files.request",
    requestId: "file",
    operation: { op: "download", path: "token" },
  });
  expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
});
