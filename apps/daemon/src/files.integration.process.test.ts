import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { AgentId, DeviceId, ServerMessage, FilesServerMessage } from "@ace/protocol";
import { decodeFileFrame } from "@ace/files";
import { workspaceRuntime } from "@ace/workspace";
import { startRelay, connectClientViaRelay } from "@ace/relay";
import { startDaemon, createDevThread, type DaemonOptions } from "./index.ts";
import { message, shell } from "./payload-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
class Client {
  readonly socket: WebSocket;
  private queue: unknown[] = [];
  private waiters: ((value: unknown) => void)[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data, binary) => {
      const value: unknown = binary
        ? z.instanceof(Buffer).parse(data)
        : ServerMessage.parse(JSON.parse(data.toString()));
      if (!binary && ServerMessage.parse(value).type === "models.changed") return;
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
  request(operation: unknown) {
    this.send({ type: "files.request", requestId: "r", operation });
    return this.next();
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const ended = once(this.socket, "close");
    this.socket.terminate();
    await ended;
  }
}
async function setup(relayUrl?: string, files?: DaemonOptions["files"]) {
  const home = await mkdtemp(join(tmpdir(), "ace-daemon-files-review-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "workspace");
  await mkdir(root);
  const daemon = await startDaemon({
    ...(files ? { files } : {}),
    config: {
      dataDir: join(home, "data"),
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "silent",
      ...(relayUrl ? { relayUrl } : {}),
    },
  });
  cleanup.push(() => daemon.close());
  const connect = async (paired?: { device: { id: string }; token: string }) => {
    const client = new Client(daemon.url);
    cleanup.push(() => client.close());
    await once(client.socket, "open");
    const credential = paired
      ? z.object({ ticket: z.string() }).parse(
          await (
            await fetch(daemon.url.replace(/^ws:/, "http:") + "/v1/tickets", {
              method: "POST",
              headers: { Authorization: `Bearer ${paired.token}` },
            })
          ).json(),
        )
      : { token: (await readFile(daemon.tokenPath, "utf8")).trim() };
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired?.device.id ?? "owner",
      ...credential,
    });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    return client;
  };
  return { home, root, daemon, connect };
}
async function artifact(client: Client, artifactId: string): Promise<Buffer> {
  const ready = z
    .object({ channel: z.number(), size: z.number() })
    .parse(await client.request({ op: "artifact.download", artifactId, offset: 0 }));
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < ready.size) {
    client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
    const frame = decodeFileFrame(z.instanceof(Buffer).parse(await client.next()));
    expect(frame.offset).toBe(offset);
    chunks.push(frame.bytes);
    offset += frame.bytes.length;
  }
  const bytes = Buffer.concat(chunks);
  expect(await client.next()).toMatchObject({
    type: "files.end",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return bytes;
}

it("publishes daemon file mutations to affected workspace thread events and serves a real support artifact", async () => {
  const f = await setup();
  const workspace = f.daemon.store.createWorkspace(f.root, "Workspace");
  const thread = createDevThread(f.daemon.store, workspace);
  const other = createDevThread(
    f.daemon.store,
    f.daemon.store.createWorkspace(join(f.home, "other"), "Other"),
  );
  const before = f.daemon.store.headSeq();
  const files = f.daemon.files;
  if (!files) throw new Error("No daemon files");
  await files.request("owner", {
    op: "create",
    path: "agent-visible",
    expected: null,
    text: "visible",
  });
  expect(
    f.daemon.store.readEvents({ afterSeq: before, threadId: thread.id, limit: 10 }),
  ).toMatchObject([
    {
      payload: {
        type: "workspace.files_changed",
        workspaceId: workspace,
        change: { path: "agent-visible", op: "create" },
      },
    },
  ]);
  expect(f.daemon.store.readEvents({ afterSeq: before, threadId: other.id, limit: 10 })).toEqual(
    [],
  );
  const client = await f.connect();
  expect(await client.request({ op: "artifacts.list" })).toMatchObject({
    value: [expect.objectContaining({ id: "daemon-support", category: "support" })],
  });
  const support = JSON.parse((await artifact(client, "daemon-support")).toString());
  expect(support).toMatchObject({ node: process.version, platform: process.platform });
  expect(JSON.stringify(support)).not.toContain(
    (await readFile(f.daemon.tokenPath, "utf8")).trim(),
  );
});
it("exports daemon output and full ADR 0006 raw blobs through the bounded artifact download channel", async () => {
  const f = await setup();
  const workspace = f.daemon.store.createWorkspace(f.root, "Workspace");
  const thread = createDevThread(f.daemon.store, workspace);
  const outputText = "abc😀def".repeat(20000);
  const native = { text: "é".repeat(80 * 1024), unknown: { kept: true } };
  const rawItem = message("raw");
  if (rawItem.type !== "message") throw new Error("Wrong item");
  rawItem.raw = [{ type: "future", data: native }];
  f.daemon.store.appendEvents(thread.id, [
    { type: "item.created", item: shell() },
    {
      type: "item.delta",
      itemId: shell().id,
      agentId: AgentId.parse("root"),
      field: "output",
      append: outputText,
    },
    {
      type: "item.delta",
      itemId: shell().id,
      agentId: AgentId.parse("root"),
      field: "output",
      append: "tail",
    },
    { type: "item.created", item: rawItem },
  ]);
  const stored = f.daemon.store.snapshotThread(thread.id).items.raw;
  if (stored?.type !== "message") throw new Error("No raw item");
  const raw = stored.raw.at(0);
  if (!raw || !("blobRef" in raw)) throw new Error("No blob reference");
  const client = await f.connect(f.daemon.store.devices.create("Reader", ["read"], 1));
  const output = z
    .object({ value: z.object({ artifactId: z.string() }) })
    .parse(await client.request({ op: "artifact.output", streamId: "output:shell" }));
  expect((await artifact(client, output.value.artifactId)).toString()).toBe(outputText + "tail");
  const blob = z
    .object({ value: z.object({ artifactId: z.string() }) })
    .parse(await client.request({ op: "artifact.raw", blobRef: raw.blobRef }));
  expect((await artifact(client, blob.value.artifactId)).toString()).toBe(JSON.stringify(native));
  const outsider = createDevThread(
    f.daemon.store,
    f.daemon.store.createWorkspace(join(f.home, "outside"), "Other"),
  );
  f.daemon.store.appendEvents(outsider.id, [
    { type: "item.created", item: shell("denied") },
    {
      type: "item.delta",
      itemId: shell("denied").id,
      agentId: AgentId.parse("root"),
      field: "output",
      append: "private",
    },
  ]);
  expect(await client.request({ op: "artifact.output", streamId: "output:denied" })).toMatchObject({
    code: "FORBIDDEN",
  });
});
it("hosts authenticated encrypted file transfers from normal daemon startup and rechecks device revocation", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const f = await setup(relay.url);
  await writeFile(join(f.root, "binary"), Buffer.from([0, 255, 19]));
  const paired = f.daemon.store.devices.create("Phone", ["read"], 1);
  const hostId = f.daemon.relayHostId;
  const fingerprint = f.daemon.relayFingerprint;
  if (!hostId || !fingerprint) throw new Error("No production relay endpoint");
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId,
    pinnedFingerprint: fingerprint,
  });
  cleanup.push(async () => {
    client.close();
    await client.closed;
  });
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: paired.device.id,
    token: paired.token,
  });
  expect(await client.receive()).toMatchObject({ type: "welcome" });
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "download", path: "binary", offset: 0 },
  });
  const ready = z.object({ channel: z.number() }).parse(await relayFileReply(client));
  await client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  expect(decodeFileFrame(Buffer.from(await relayFileFrame(client))).bytes).toEqual(
    Buffer.from([0, 255, 19]),
  );
  expect(await relayFileReply(client)).toMatchObject({ type: "files.end" });
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "create", path: "denied", expected: null, text: "bad" },
  });
  expect(FilesServerMessage.parse(await relayFileReply(client))).toMatchObject({
    code: "FORBIDDEN",
  });
  f.daemon.store.devices.revoke(paired.device.id, 2);
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "stat", path: "binary" },
  });
  expect(await relayFileReply(client)).toMatchObject({ code: "FORBIDDEN" });
  const admin = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId,
    pinnedFingerprint: fingerprint,
  });
  cleanup.push(async () => {
    admin.close();
    await admin.closed;
  });
  await admin.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("owner"),
    token: (await readFile(f.daemon.tokenPath, "utf8")).trim(),
  });
  await expect(admin.receive()).rejects.toThrow();
});

it("exports a redacted diagnostics support bundle for a read-only remote client", async () => {
  const f = await setup();
  const token = (await readFile(f.daemon.tokenPath, "utf8")).trim();
  await writeFile(
    join(f.home, "data", "logs", "ace.999.jsonl"),
    JSON.stringify({ token, message: "retained diagnostic" }) + "\n",
  );
  const client = await f.connect(f.daemon.store.devices.create("Reader", ["read"], 1));
  const exported = z
    .object({ value: z.object({ artifactId: z.string() }) })
    .parse(await client.request({ op: "artifact.support" }));
  const bundle = gunzipSync(await artifact(client, exported.value.artifactId)).toString();
  expect(bundle).toContain("retained diagnostic");
  expect(bundle).not.toContain(token);
  expect(bundle).toContain('"providerProbesRun":false');
});

it("legacy and scoped routes share upload recovery, trash and artifact catalogs for a canonical workspace", async () => {
  const runtime = workspaceRuntime();
  const filesystem = runtime.filesystem;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  runtime.filesystem = {
    ...filesystem,
    async lstat(path) {
      if (hold && path.endsWith("/cas")) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      return filesystem.lstat(path);
    },
  };
  const f = await setup(undefined, { workspaceRuntime: runtime });
  // Always unblock I/O before daemon cleanup, including assertion failures.
  cleanup.push(async () => {
    release.resolve();
  });
  const workspace = f.daemon.store.createWorkspace(f.root, "Workspace");
  const thread = createDevThread(f.daemon.store, workspace);
  const client = await f.connect();
  const files = f.daemon.files;
  if (!files) throw new Error("Files missing");
  const upload = z
    .object({ uploadId: z.string() })
    .parse(
      await files.request("owner", { op: "upload.begin", path: "resume", size: 3, expected: null }),
    );
  client.send({
    type: "files.request",
    requestId: "resume",
    threadId: thread.id,
    operation: { op: "upload.resume", uploadId: upload.uploadId },
  });
  const resumed = FilesServerMessage.parse(await fileReply(client));
  expect(resumed).toMatchObject({ type: "files.upload", uploadId: upload.uploadId, offset: 0 });
  if (resumed.type === "files.upload")
    client.send({ type: "files.cancel", channel: resumed.channel });
  if (resumed.type === "files.upload")
    expect(await fileReply(client)).toMatchObject({ type: "files.cancelled" });
  await files.request("owner", { op: "create", path: "trash-me", text: "kept", expected: null });
  const { version } = z
    .object({ version: z.string() })
    .parse(await files.request("owner", { op: "stat", path: "trash-me" }));
  const removed = z
    .object({ trashId: z.string() })
    .parse(await files.request("owner", { op: "delete", path: "trash-me", expected: version }));
  client.send({
    type: "files.request",
    requestId: "trash",
    threadId: thread.id,
    operation: { op: "trash.list" },
  });
  expect(await fileReply(client)).toMatchObject({
    type: "files.result",
    value: {
      entries: [
        expect.objectContaining({ id: removed.trashId, path: "trash-me", size: 4, version }),
      ],
      nextCursor: null,
    },
  });
  client.send({
    type: "files.request",
    requestId: "artifacts",
    threadId: thread.id,
    operation: { op: "artifacts.list" },
  });
  expect(await fileReply(client)).toMatchObject({
    type: "files.result",
    value: expect.arrayContaining([expect.objectContaining({ id: "daemon-support" })]),
  });
  await files.request("owner", { op: "create", path: "cas", text: "before", expected: null });
  const before = z
    .object({ version: z.string() })
    .parse(await files.request("owner", { op: "stat", path: "cas" }));
  hold = true;
  client.send({
    type: "files.request",
    requestId: "cas",
    threadId: thread.id,
    operation: { op: "write", path: "cas", expected: before.version, text: "scoped" },
  });
  // The scoped mutation is already at filesystem I/O when the legacy request is admitted.
  await entered.promise;
  const legacy = files
    .request("owner", { op: "write", path: "cas", expected: before.version, text: "legacy" })
    .then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
  try {
    // A non-mutating read settles while the first write still holds the mutation queue.
    expect(await files.request("owner", { op: "stat", path: "cas" })).toMatchObject({
      version: before.version,
    });
    expect(await readFile(join(f.root, "cas"), "utf8")).toBe("before");
  } finally {
    release.resolve();
  }
  const scoped = FilesServerMessage.parse(await fileReply(client));
  expect(scoped).toMatchObject({ type: "files.result", requestId: "cas" });
  expect(await legacy).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(await readFile(join(f.root, "cas"), "utf8")).toBe("scoped");
});

async function fileReply(client: Client): Promise<import("@ace/protocol").FilesServerMessage> {
  for (;;) {
    const reply = FilesServerMessage.parse(await client.next());
    if (reply.type !== "files.changed") return reply;
  }
}

async function relayFileReply(client: Awaited<ReturnType<typeof connectClientViaRelay>>) {
  for (;;) {
    const reply = await client.receive();
    const parsed = ServerMessage.parse(reply);
    if (parsed.type !== "models.changed" && parsed.type !== "files.changed") return reply;
  }
}

async function relayFileFrame(client: Awaited<ReturnType<typeof connectClientViaRelay>>) {
  for (;;) {
    const frame = await client.receiveFrame();
    if (frame instanceof Uint8Array) return frame;
    const parsed = ServerMessage.parse(frame);
    if (parsed.type !== "models.changed" && parsed.type !== "files.changed")
      throw new Error("Expected a binary file frame");
  }
}
