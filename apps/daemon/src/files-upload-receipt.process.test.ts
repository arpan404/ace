import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { FilesServerMessage, ServerMessage } from "@ace/protocol";
import { createDevThread, startDaemon } from "./index.ts";

/*
 * A phone's upload whose commit reply never arrived: the daemon published the file, the
 * connection went, and the phone reconnects holding only the upload's id. The daemon's answer
 * must tell it the file is in place (and at which version), never invite a second upload.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** The handshake's reply, or a file reply; the daemon's own broadcasts are skipped. */
function reply(raw: unknown): ServerMessage | FilesServerMessage | undefined {
  const files = FilesServerMessage.safeParse(raw);
  if (files.success) return files.data.type === "files.changed" ? undefined : files.data;
  const server = ServerMessage.safeParse(raw);
  return server.success && server.data.type === "welcome" ? server.data : undefined;
}

class Socket {
  readonly socket: WebSocket;
  private queue: unknown[] = [];
  private waiters: ((value: unknown) => void)[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data) => {
      const value = reply(JSON.parse(data.toString()));
      if (!value) return;
      const waiting = this.waiters.shift();
      if (waiting) waiting(value);
      else this.queue.push(value);
    });
  }
  next(): Promise<unknown> {
    const value = this.queue.shift();
    return value === undefined
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve(value);
  }
  send(value: unknown) {
    this.socket.send(JSON.stringify(value));
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const ended = once(this.socket, "close");
    this.socket.terminate();
    await ended;
  }
}

it("resuming an upload the daemon already published answers COMMITTED, and committing again returns the same version", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-upload-receipt-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "workspace");
  await mkdir(root);
  const daemon = await startDaemon({
    config: {
      dataDir: join(home, "data"),
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "silent",
    },
  });
  cleanup.push(() => daemon.close());
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(root, "Workspace"));
  const token = (await readFile(daemon.tokenPath, "utf8")).trim();
  const connect = async () => {
    const socket = new Socket(daemon.url);
    cleanup.push(() => socket.close());
    await once(socket.socket, "open");
    socket.send({ type: "hello", protocolVersion: 1, deviceId: "phone", token });
    expect(await socket.next()).toMatchObject({ type: "welcome" });
    return socket;
  };
  const request = async (socket: Socket, operation: unknown) => {
    socket.send({ type: "files.request", requestId: "r", threadId: thread.id, operation });
    return FilesServerMessage.parse(await socket.next());
  };

  const bytes = Buffer.from("sent once\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const first = await connect();
  const opened = await request(first, {
    op: "upload.begin",
    path: "landed.txt",
    expected: null,
    size: bytes.length,
  });
  if (opened.type !== "files.upload") throw new Error(`Upload refused: ${JSON.stringify(opened)}`);
  first.send({
    type: "files.chunk",
    requestId: "c",
    channel: opened.channel,
    offset: 0,
    data: bytes.toString("base64"),
  });
  expect(await first.next()).toMatchObject({ type: "files.upload", offset: bytes.length });
  const committed = await request(first, {
    op: "upload.commit",
    uploadId: opened.uploadId,
    sha256,
  });
  const version = z
    .object({ type: z.literal("files.result"), value: z.object({ version: z.string() }) })
    .parse(committed).value.version;
  // The reply above is the one a phone lost: it reconnects knowing only the upload's id.
  await first.close();

  const again = await connect();
  expect(await request(again, { op: "upload.resume", uploadId: opened.uploadId })).toMatchObject({
    type: "files.error",
    code: "COMMITTED",
  });
  expect(
    await request(again, { op: "upload.commit", uploadId: opened.uploadId, sha256 }),
  ).toMatchObject({ type: "files.result", value: { path: "landed.txt", version } });
  expect(await readFile(join(root, "landed.txt"), "utf8")).toBe("sent once\n");
  expect((await readdir(root)).filter((name) => name.startsWith("landed"))).toEqual(["landed.txt"]);
});
