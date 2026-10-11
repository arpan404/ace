import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { keyPair, fingerprint as relayKeyFingerprint } from "@ace/secure-channel";
import { RemoteAuth } from "./remote-auth.ts";
import { startFilesRelay } from "./files-relay.ts";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { AgentId, DeviceId, ClientMessage, ServerMessage, FilesServerMessage } from "@ace/protocol";
import { decodeFileFrame } from "@ace/files";
import { workspaceRuntime } from "@ace/workspace";
import { startRelay, connectClientViaRelay } from "@ace/relay";
import { startDaemon, createDevThread, stubHandler, type DaemonOptions } from "./index.ts";
import { startServer } from "./server.ts";
import { FilesWorkspaces } from "./files-workspaces.ts";
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
      if (
        !binary &&
        ["models.changed", "providers.changed", "usage.limits_changed"].includes(
          ServerMessage.parse(value).type,
        )
      )
        return;
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
    // A non-mutating read settles while the scoped writer is still preparing.
    expect(await files.request("owner", { op: "stat", path: "cas" })).toMatchObject({
      version: before.version,
    });
    expect(await readFile(join(f.root, "cas"), "utf8")).toBe("before");
  } finally {
    release.resolve();
  }
  const scoped = FilesServerMessage.parse(await fileReply(client));
  const legacyResult = await legacy;
  expect(scoped).toMatchObject({ requestId: "cas" });
  if (scoped.type === "files.result") {
    expect(legacyResult).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await readFile(join(f.root, "cas"), "utf8")).toBe("scoped");
  } else {
    expect(scoped).toMatchObject({ type: "files.error", code: "CONFLICT" });
    expect(legacyResult).toMatchObject({ ok: true });
    expect(await readFile(join(f.root, "cas"), "utf8")).toBe("legacy");
  }
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

for (const transport of ["websocket", "relay"]) {
  it(`read-only ${transport} exports exact thread-scoped output and raw bytes while denying mutations`, async () => {
    const relay = transport === "relay" ? await startRelay() : undefined;
    if (relay) cleanup.push(() => relay.close());
    const f = await setup(relay?.url);
    const workspace = f.daemon.store.createWorkspace(f.root, "Workspace");
    const thread = createDevThread(f.daemon.store, workspace);
    const native = { text: "raw retained bytes".repeat(5000) };
    const rawItem = message("scoped-raw");
    if (rawItem.type !== "message") throw new Error("Wrong item");
    rawItem.raw = [{ type: "future", data: native }];
    f.daemon.store.appendEvents(thread.id, [
      { type: "item.created", item: shell() },
      {
        type: "item.delta",
        itemId: shell().id,
        agentId: AgentId.parse("root"),
        field: "output",
        append: "retained output\n",
      },
      { type: "item.created", item: rawItem },
    ]);
    const stored = f.daemon.store.snapshotThread(thread.id).items[rawItem.id];
    if (stored?.type !== "message") throw new Error("Missing message");
    const raw = stored.raw[0];
    if (!raw || !("blobRef" in raw)) throw new Error("Missing blob");
    const paired = f.daemon.store.devices.create("Reader", ["read"], 1);
    let client: { send(value: unknown): void | Promise<void>; next(): Promise<unknown> };
    if (relay) {
      const hostId = f.daemon.relayHostId;
      const fingerprint = f.daemon.relayFingerprint;
      if (!hostId || !fingerprint) throw new Error("Missing relay endpoint");
      const remote = await connectClientViaRelay({
        relayUrl: relay.url,
        hostId,
        pinnedFingerprint: fingerprint,
      });
      cleanup.push(async () => {
        remote.close();
        await remote.closed;
      });
      await remote.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: paired.device.id,
        token: paired.token,
      });
      expect(await remote.receive()).toMatchObject({ type: "welcome" });
      client = {
        send: (value) => remote.send(ClientMessage.parse(value)),
        next: () => relayFileReply(remote),
      };
    } else {
      const local = await f.connect(paired);
      client = { send: (value) => local.send(value), next: () => fileReply(local) };
    }
    const request = async (operation: unknown) => {
      await client.send({
        type: "files.request",
        requestId: "scoped",
        threadId: thread.id,
        operation,
      });
      return FilesServerMessage.parse(await client.next());
    };
    for (const [operation, expected] of [
      [{ op: "artifact.output", streamId: "output:shell" }, "retained output\n"],
      [{ op: "artifact.raw", blobRef: raw.blobRef }, JSON.stringify(native)],
    ] as const) {
      const exported = await request(operation);
      expect(exported).toMatchObject({ type: "files.result" });
      const result = z.object({ value: z.object({ artifactId: z.string() }) }).parse(exported);
      const ready = z.object({ channel: z.number() }).parse(
        await request({
          op: "artifact.download",
          artifactId: result.value.artifactId,
          offset: 0,
        }),
      );
      const chunks: Buffer[] = [];
      for (;;) {
        await client.send({ type: "files.pull", requestId: "pull", channel: ready.channel });
        const data = FilesServerMessage.parse(await client.next());
        if (data.type !== "files.data") throw new Error(`Unexpected ${data.type}`);
        chunks.push(Buffer.from(data.data, "base64"));
        if (data.eof) break;
      }
      expect(Buffer.concat(chunks).toString()).toBe(expected);
    }
    for (const operation of [
      { op: "create", path: "denied", expected: null, text: "bad" },
      { op: "upload.begin", path: "denied", expected: null, size: 1 },
      {
        op: "move",
        path: "denied",
        destination: "other",
        destinationExpected: null,
        expected: "unknown",
      },
      { op: "delete", path: "denied", expected: "unknown" },
    ])
      expect(await request(operation)).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
    expect(await request({ op: "artifact.output", streamId: "output:missing" })).toMatchObject({
      type: "files.error",
    });
  });
}

for (const transport of ["websocket", "relay"])
  it(`read-only ${transport} exports cannot borrow an allowed thread to read another source or its registered artifact`, async () => {
    const f = await setup();
    const store = f.daemon.store;
    const workspace = store.createWorkspace(f.root, "Workspace");
    const allowed = createDevThread(store, workspace);
    const denied = createDevThread(store, workspace);
    const rawItem = message("private-raw");
    if (rawItem.type !== "message") throw new Error("Wrong item");
    const native = { secret: "private bytes".repeat(10000) };
    rawItem.raw = [{ type: "future", data: native }];
    store.appendEvents(denied.id, [
      { type: "item.created", item: shell("private-shell") },
      {
        type: "item.delta",
        itemId: shell("private-shell").id,
        agentId: AgentId.parse("root"),
        field: "output",
        append: "private output",
      },
      { type: "item.created", item: rawItem },
    ]);
    store.appendEvents(allowed.id, [
      { type: "item.created", item: shell("public-shell") },
      {
        type: "item.delta",
        itemId: shell("public-shell").id,
        agentId: AgentId.parse("root"),
        field: "output",
        append: "allowed bytes",
      },
    ]);
    const stored = store.snapshotThread(denied.id).items[rawItem.id];
    if (stored?.type !== "message") throw new Error("Missing message");
    const raw = stored.raw[0];
    if (!raw || !("blobRef" in raw)) throw new Error("Missing blob");
    const files = f.daemon.files;
    if (!files) throw new Error("Missing files");
    const secretArtifact = z
      .object({ artifactId: z.string() })
      .parse(
        await files.request("owner", { op: "artifact.output", streamId: "output:private-shell" }),
      ).artifactId;
    let counter = 0;
    const scoped = new FilesWorkspaces({
      store,
      options: {},
      now: () => 1,
      id: () => `scope-${++counter}`,
      config: {
        dataDir: join(f.home, "scoped"),
        host: "127.0.0.1",
        port: 0,
        remotePort: 0,
        listen: "local",
        logLevel: "silent",
      },
    });
    scoped.register(await realpath(f.root), files);
    cleanup.push(() => scoped.close());
    let readable = true;
    const server = await startServer({
      port: 0,
      token: "a".repeat(64),
      hostId: "source-auth",
      store,
      files,
      threadFiles: scoped,
      handler: stubHandler({ development: true }),
      canReadThread: (_device, thread) => readable && thread === allowed.id,
    });
    cleanup.push(() => server.close());
    const paired = store.devices.create("Reader", ["read"], 1);
    let client: { send(value: unknown): void | Promise<void>; next(): Promise<unknown> };
    if (transport === "relay") {
      const relay = await startRelay();
      cleanup.push(() => relay.close());
      const keys = keyPair();
      const host = await startFilesRelay({
        url: relay.url,
        keys,
        auth: new RemoteAuth(store.devices, "a".repeat(64), { now: () => 1, secret: randomUUID }),
        devices: store.devices,
        store,
        files,
        threadFiles: scoped,
        hostId: "source-auth",
        headSeq: () => store.headSeq(),
        canReadThread: (_device, thread) => readable && thread === allowed.id,
      });
      cleanup.push(() => host.close());
      const remote = await connectClientViaRelay({
        relayUrl: relay.url,
        hostId: host.hostId,
        pinnedFingerprint: relayKeyFingerprint(keys.publicKey),
      });
      cleanup.push(async () => {
        remote.close();
        await remote.closed;
      });
      await remote.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: paired.device.id,
        token: paired.token,
      });
      expect(await remote.receive()).toMatchObject({ type: "welcome" });
      client = {
        send: (value) => remote.send(ClientMessage.parse(value)),
        next: () => relayFileReply(remote),
      };
    } else {
      const local = new Client(server.url);
      cleanup.push(() => local.close());
      await once(local.socket, "open");
      local.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: paired.device.id,
        token: paired.token,
      });
      expect(await local.next()).toMatchObject({ type: "welcome" });
      client = { send: (value) => local.send(value), next: () => fileReply(local) };
    }
    const request = async (operation: unknown, scopedRequest = true) => {
      await client.send({
        type: "files.request",
        requestId: "source",
        ...(scopedRequest ? { threadId: allowed.id } : {}),
        operation,
      });
      return FilesServerMessage.parse(await client.next());
    };
    for (const operation of [
      { op: "artifact.output", streamId: "output:private-shell" },
      { op: "artifact.raw", blobRef: raw.blobRef },
      { op: "artifact.download", artifactId: secretArtifact, offset: 0 },
    ]) {
      expect(await request(operation)).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
      expect(await request(operation, false)).toMatchObject({
        type: "files.error",
        code: "FORBIDDEN",
      });
    }
    const publicArtifact = z
      .object({ value: z.object({ artifactId: z.string() }) })
      .parse(await request({ op: "artifact.output", streamId: "output:public-shell" }))
      .value.artifactId;
    const ready = z
      .object({ channel: z.number() })
      .parse(await request({ op: "artifact.download", artifactId: publicArtifact, offset: 0 }));
    readable = false;
    await client.send({ type: "files.pull", requestId: "revoked", channel: ready.channel });
    expect(await client.next()).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
  });
