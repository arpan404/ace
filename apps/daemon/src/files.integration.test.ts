import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { AgentId, DeviceId, ServerMessage, FilesServerMessage } from "@ace/protocol";
import { decodeFileFrame } from "@ace/files";
import { startRelay, connectClientViaRelay } from "@ace/relay";
import { startDaemon, createDevThread } from "./index.ts";
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
    this.socket.close();
    await ended;
  }
}
async function setup(relayUrl?: string) {
  const home = await mkdtemp(join(tmpdir(), "ace-daemon-files-review-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "workspace");
  await mkdir(root);
  const daemon = await startDaemon({
    dataDir: join(home, "data"),
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    listen: "local",
    remotePort: 0,
    logLevel: "silent",
    ...(relayUrl ? { relayUrl } : {}),
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
  const ready = z.object({ channel: z.number() }).parse(await client.receive());
  await client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  expect(
    decodeFileFrame(Buffer.from(z.instanceof(Uint8Array).parse(await client.receiveFrame()))).bytes,
  ).toEqual(Buffer.from([0, 255, 19]));
  expect(await client.receive()).toMatchObject({ type: "files.end" });
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "create", path: "denied", expected: null, text: "bad" },
  });
  expect(FilesServerMessage.parse(await client.receive())).toMatchObject({ code: "FORBIDDEN" });
  f.daemon.store.devices.revoke(paired.device.id, 2);
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "stat", path: "binary" },
  });
  expect(await client.receive()).toMatchObject({ code: "FORBIDDEN" });
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
