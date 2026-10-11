import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FilesService } from "@ace/files";
import type { ArtifactChannel } from "@ace/files/client";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { expect, test } from "vitest";
import { ContextService } from "@ace/context";
import {
  Client,
  ClientCore,
  webSocketTransport,
  authenticatedChannel,
  type ClientOptions,
} from "@ace/client";
import { binaryAttachment } from "@ace/client/attachment-source";
import type { AttachmentInput } from "@ace/client/attachments";
import { ClientHost, RemoteClient, type PortLike } from "@ace/client-worker";
import { DeviceId, ThreadId, FilesServerMessage } from "@ace/protocol";
import { keyPair, fingerprint } from "@ace/secure-channel";
import { startRelay } from "@ace/relay";
import { fixture, token } from "./socket-test-support.ts";
import { createDevThread } from "./commands.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { startFilesRelay } from "./files-relay.ts";

const schedule = (callback: () => void, delay: number) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};
const scheduler = { set: (delay: number, callback: () => void) => schedule(callback, delay) };
async function setup() {
  let service: ContextService | undefined;
  const opened = Promise.withResolvers<void>();
  let openingGate: Promise<void> | undefined;
  let closedDownloads = 0;
  const get = () => {
    if (!service) throw new Error("Context not initialized");
    return service;
  };
  const filesHome = await mkdtemp(join(tmpdir(), "ace-original-files-"));
  const files = await FilesService.create({
    workspace: filesHome,
    dataDir: join(filesHome, ".files"),
    now: () => 1000,
    id: randomUUID,
    authorize: () => true,
  });
  const f = await fixture({
    files,
    context: {
      handle: (...args) => {
        if (args[1].operation.op === "attachment.read" && args[1].operation.variant === "original")
          throw new Error("Base64 original fallback was used");
        return get().handle(...args);
      },
      async downloadAttachment(...args) {
        const download = await get().downloadAttachment(...args);
        opened.resolve();
        await openingGate;
        return {
          ...download,
          async close() {
            await download.close();
            closedDownloads++;
          },
        };
      },
    },
  });
  const context = await ContextService.open({
    root: join(f.home, "context"),
    now: () => 1000,
    id: randomUUID,
    authorize: (_device, id) => f.store.getThread(ThreadId.parse(id)) !== undefined,
    workspace: () => undefined,
  });
  service = context;
  const bytes = await readFile(
    new URL("../../../packages/context/fixtures/colours.png", import.meta.url),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = await context.uploads.handle("owner", {
    op: "upload.begin",
    threadId: f.thread.id,
    sha256,
    bytes: bytes.length,
    name: "original.png",
  });
  if (begin.kind !== "upload") throw new Error("Missing upload");
  for (let offset = 0; offset < bytes.length; offset += 65531)
    await context.uploads.handle("owner", {
      op: "upload.chunk",
      uploadId: begin.uploadId,
      offset,
      data: bytes.subarray(offset, offset + 65531).toString("base64"),
    });
  await context.uploads.handle("owner", { op: "upload.commit", uploadId: begin.uploadId });
  const changed = Promise.withResolvers<void>();
  let binaryFrames = 0;
  let sockets = 0;
  const observe = (channel: ArtifactChannel): ArtifactChannel => ({
    ...channel,
    open(handlers) {
      channel.open({
        ...handlers,
        message(frame) {
          if (frame instanceof Uint8Array) binaryFrames++;
          else if (
            typeof frame === "object" &&
            frame !== null &&
            "type" in frame &&
            frame.type === "files.changed"
          )
            changed.resolve();
          handlers.message(frame);
        },
      });
    },
  });
  const options: ClientOptions = {
    deviceId: DeviceId.parse("device"),
    transport: () =>
      webSocketTransport(() => {
        sockets++;
        const socket = new WebSocket(f.server.url);
        socket.on("message", (_data, binary) => {
          if (binary) binaryFrames++;
        });
        return socket;
      }),
    credential: async () => token,
    storage: { load: async () => null, save: async () => {} },
    scheduler,
    random: () => 0.5,
    id: randomUUID,
  };
  return {
    ...f,
    context,
    files,
    observe,
    changed: changed.promise,
    downloadOpened: opened.promise,
    pauseDownloads(gate?: Promise<void>) {
      openingGate = gate;
    },
    closedDownloads: () => closedDownloads,
    binaryFrames: () => binaryFrames,
    sockets: () => sockets,
    bytes,
    sha256,
    options,
    input: { threadId: f.thread.id, sha256, variant: "original" as const, maxBytes: bytes.length },
    async close() {
      await f.close();
      await context.close();
      await files.close();
      await rm(filesHome, { recursive: true, force: true });
    },
  };
}

test("local originals pace exact image bytes and worker reads transfer buffers without base64 context reads", async () => {
  const f = await setup();
  const client = new Client({
    ...f.options,
    id() {
      return `${this.random()}-${randomUUID()}`;
    },
  });
  const changes = Promise.withResolvers<void>();
  const stopChanges = client.onMessage((message) => {
    if (message.type === "files.changed") changes.resolve();
  });
  const core = new ClientCore(f.options);
  const { port1, port2 } = new MessageChannel();
  const transferred: ArrayBuffer[] = [];
  const bridge: PortLike = {
    postMessage(message: unknown, transfer: ArrayBuffer[] = []) {
      port1.postMessage(message, transfer);
      for (const buffer of transfer) {
        if (!(buffer instanceof ArrayBuffer)) throw new Error("Unexpected transfer");
        transferred.push(buffer);
      }
    },
    addEventListener: (type, listener) => port1.addEventListener(type, listener),
    removeEventListener: (type, listener) => port1.removeEventListener(type, listener),
    start: () => port1.start(),
    close: () => port1.close(),
  };
  const host = new ClientHost({
    target: () => ({ key: "local", create: () => core }),
    scheduler,
    now: () => 0,
    lingerMs: 1,
  });
  host.attach(bridge);
  const remote = new RemoteClient(port2, {}, { scheduler });
  try {
    await client.start();
    await expect.poll(() => client.state).toBe("ready");
    const frames = client.attachmentChunks(f.input);
    expect((await frames.next()).value).toEqual({ bytes: f.bytes.length, mimeType: "image/png" });
    const first = (await frames.next()).value;
    expect(first).toBeInstanceOf(Uint8Array);
    if (!(first instanceof Uint8Array)) throw new Error("Missing binary chunk");
    expect(first.byteLength).toBe(65536);
    await f.files.request("owner", { op: "mkdir", path: "local-change", expected: null });
    await changes.promise;

    expect(f.sockets()).toBe(1);
    expect(f.binaryFrames()).toBe(1);
    const chunks = [first];
    for await (const frame of frames) {
      if (!(frame instanceof Uint8Array)) throw new Error("Repeated metadata");
      expect(frame.length).toBeLessThanOrEqual(65536);
      chunks.push(frame);
    }
    expect(Buffer.concat(chunks)).toEqual(f.bytes);
    await remote.start();
    await expect.poll(() => remote.state).toBe("ready");
    const aborted = new AbortController();
    aborted.abort();
    await expect(remote.attachmentBytes(f.input, { signal: aborted.signal })).rejects.toMatchObject(
      { code: "aborted" },
    );
    expect(transferred).toHaveLength(0);
    await expect(remote.attachmentBytes(f.input, { timeoutMs: 0 })).rejects.toMatchObject({
      code: "protocol",
    });
    await expect(client.attachmentBytes(f.input, { timeoutMs: 0 })).rejects.toMatchObject({
      code: "limit",
    });
    expect(transferred).toHaveLength(0);
    const image = await remote.attachmentBytes(f.input);
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.bytes)).toEqual(f.bytes);
    expect(transferred).toHaveLength(Math.ceil(f.bytes.length / 65536));
    expect(transferred.every((buffer) => buffer.byteLength === 0)).toBe(true);
    expect(f.sockets()).toBe(2);
    const parallel = await Promise.all([
      client.attachmentBytes(f.input),
      client.attachmentBytes(f.input),
    ]);
    expect(parallel.map((result) => Buffer.from(result.bytes))).toEqual([f.bytes, f.bytes]);
    const other = createDevThread(f.store, f.workspace);
    const continuing = client.attachmentChunks(f.input);
    await continuing.next();
    const initial = (await continuing.next()).value;
    if (!(initial instanceof Uint8Array)) throw new Error("Missing concurrent chunk");
    await expect(client.attachmentBytes({ ...f.input, threadId: other.id })).rejects.toThrow();
    const rest = [initial];
    for await (const frame of continuing) if (frame instanceof Uint8Array) rest.push(frame);
    expect(Buffer.concat(rest)).toEqual(f.bytes);
    await expect(remote.attachmentBytes({ ...f.input, threadId: other.id })).rejects.toThrow();
    await expect(
      remote.attachmentBytes({ ...f.input, maxBytes: f.bytes.length - 1 }),
    ).rejects.toThrow();
    const forbidden = new Client({
      ...f.options,
      attachmentSource: async function* (input, options) {
        const channel = authenticatedChannel(
          {
            target: { kind: "local", url: f.server.url },
            expectedHostId: "different-host",
            deviceId: "device",
            credential: async () => token,
            socket: (url) => new WebSocket(url),
            keys: () => {
              throw new Error("Unexpected relay");
            },
            schedule,
          },
          "files",
        );
        yield* binaryAttachment(input, channel, "forbidden", schedule, options);
      },
    });
    try {
      await forbidden.start();
      await expect.poll(() => forbidden.state).toBe("ready");
      await expect(forbidden.attachmentBytes(f.input)).rejects.toThrow("disconnected");
    } finally {
      await forbidden.close();
    }
    const deleted = client.attachmentChunks(f.input);
    await deleted.next();
    await deleted.next();
    f.store.deleteThread(f.thread.id);
    await expect(deleted.next()).rejects.toThrow();
  } finally {
    stopChanges();
    await remote.close();
    await core.close();
    await client.close();
    port1.close();
    port2.close();
    await f.close();
  }
});

test("encrypted relay originals require readable owning threads and stop after access is revoked", async () => {
  const f = await setup();
  const relay = await startRelay();
  const keys = keyPair();
  const auth = new RemoteAuth(f.store.devices, token, { now: () => 1000, secret: randomUUID });
  const reader = auth.redeem(auth.pairing(["read"]).code, "Reader");
  const operator = auth.redeem(auth.pairing(["operate"]).code, "Operator");
  let allowed = true;
  const host = await startFilesRelay({
    url: relay.url,
    keys,
    auth,
    devices: f.store.devices,
    context: f.context,
    files: f.files,
    store: f.store,
    hostId: "host",
    headSeq: () => 0,
    canReadThread: (_device, id) => allowed && id === f.thread.id,
  });
  let hostClosed = false;
  const connect = (device = reader) =>
    f.observe(
      authenticatedChannel(
        {
          target: { kind: "relay", url: relay.url, pinnedFingerprint: fingerprint(keys.publicKey) },
          expectedHostId: "host",
          deviceId: device.device.id,
          credential: async () => device.token,
          socket: (url) => new WebSocket(url),
          keys: () => ({ staticKey: keyPair(), ephemeralKey: keyPair() }),
          schedule,
        },
        "files",
      ),
    );
  const original = (input: AttachmentInput, channel: ArtifactChannel, id: string) =>
    binaryAttachment({ ...input, maxBytes: f.input.maxBytes }, channel, id, schedule, {});
  try {
    const frames = original(f.input, connect(), "original");
    await frames.next();
    const first = (await frames.next()).value;
    if (!(first instanceof Uint8Array)) throw new Error("Missing relay chunk");
    await f.files.request("owner", { op: "mkdir", path: "relay-change", expected: null });
    await f.changed;
    expect(f.binaryFrames()).toBe(1);
    const parts: Uint8Array[] = [first];
    for await (const frame of frames) if (frame instanceof Uint8Array) parts.push(frame);
    expect(Buffer.concat(parts)).toEqual(f.bytes);
    const denied = original(f.input, connect(operator), "denied");
    await expect(denied.next()).rejects.toThrow();
    const wrong = original({ ...f.input, threadId: "unrelated" }, connect(), "wrong");
    await expect(wrong.next()).rejects.toThrow();
    const revoked = original(f.input, connect(), "revoked");
    expect((await revoked.next()).value).toEqual({ bytes: f.bytes.length, mimeType: "image/png" });
    expect((await revoked.next()).value).toBeInstanceOf(Uint8Array);
    allowed = false;
    await expect(revoked.next()).rejects.toThrow();
    allowed = true;
    const cancelled = original(f.input, connect(), "cancel");
    await cancelled.next();
    await cancelled.next();
    await cancelled.return(undefined);
    // A new authenticated stream remains usable after cancellation, without resuming the old offset.
    const restarted = original(f.input, connect(), "fresh");
    const fresh: Uint8Array[] = [];
    for await (const frame of restarted) if (frame instanceof Uint8Array) fresh.push(frame);
    expect(Buffer.concat(fresh)).toEqual(f.bytes);
    const portable = new Client({
      ...f.options,
      attachmentSource: (input, options) =>
        binaryAttachment(input, connect(), "facade-relay", schedule, options),
    });
    try {
      await portable.start();
      await expect.poll(() => portable.state).toBe("ready");
      expect(Buffer.from((await portable.attachmentBytes(f.input)).bytes)).toEqual(f.bytes);
    } finally {
      await portable.close();
    }
    const disconnected = original(f.input, connect(), "disconnected");
    await disconnected.next();
    await disconnected.next();
    await host.close();
    hostClosed = true;
    await expect(disconnected.next()).rejects.toMatchObject({ code: "offline" });
  } finally {
    if (!hostClosed) await host.close();
    await relay.close();
    await f.close();
  }
});

test("cancelled openings release their leased original and reconnect cannot revive a lazy read", async () => {
  const f = await setup();
  const client = new Client(f.options);
  const gate = Promise.withResolvers<void>();
  try {
    await client.start();
    await expect.poll(() => client.state).toBe("ready");
    f.pauseDownloads(gate.promise);
    const controller = new AbortController();
    const frames = client.attachmentChunks(f.input, { signal: controller.signal });
    const failed = expect(frames.next()).rejects.toMatchObject({ code: "aborted" });
    await f.downloadOpened;
    controller.abort();
    await failed;
    gate.resolve();
    await expect.poll(f.closedDownloads).toBe(1);
    f.pauseDownloads();
    // The promise yields at lazy loading before a new socket or download is admitted.
    const obsolete = expect(client.attachmentBytes(f.input)).rejects.toMatchObject({
      code: "aborted",
    });
    client.networkOnline(false);
    client.networkOnline(true);
    await obsolete;
    await expect.poll(() => client.state).toBe("ready");
    expect(f.closedDownloads()).toBe(1);
    const fresh = await client.attachmentBytes(f.input);
    expect(Buffer.from(fresh.bytes)).toEqual(f.bytes);
  } finally {
    gate.resolve();
    await client.close();
    await f.close();
  }
});

test("pipelined ready channel collisions preserve the first original's connection and bytes", async () => {
  const f = await setup();
  const pending: string[] = [];
  let released = false;
  const client = new Client({
    ...f.options,
    transport() {
      const transport = f.options.transport();
      return {
        supportsBinary: true,
        send: (text) => transport.send(text),
        close: () => transport.close(),
        open(events) {
          transport.open({
            ...events,
            message(text) {
              const message: unknown = JSON.parse(text);
              if (
                !released &&
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "files.ready"
              ) {
                pending.push(text);
                if (pending.length !== 2) return;
                const first = FilesServerMessage.parse(JSON.parse(pending[0]!));
                const second = FilesServerMessage.parse(JSON.parse(pending[1]!));
                if (first.type !== "files.ready" || second.type !== "files.ready")
                  throw new Error("Expected two opening replies");
                released = true;
                // Same event-loop delivery exposes the reservation boundary, before either awaited reply resumes.
                events.message(JSON.stringify(first));
                events.message(JSON.stringify({ ...second, channel: first.channel }));
              } else events.message(text);
            },
          });
        },
      };
    },
  });
  const first = client.attachmentChunks(f.input);
  const second = client.attachmentChunks(f.input);
  try {
    await client.start();
    await expect.poll(() => client.state).toBe("ready");
    const opening = await Promise.allSettled([first.next(), second.next()]);
    expect(opening.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const failure = opening.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({ reason: { code: "protocol" } });
    const survivor = opening[0]?.status === "fulfilled" ? first : second;
    const bytes: Uint8Array[] = [];
    for await (const frame of survivor) if (frame instanceof Uint8Array) bytes.push(frame);
    expect(Buffer.concat(bytes)).toEqual(f.bytes);
    expect(client.state).toBe("ready");
    expect(Buffer.from((await client.attachmentBytes(f.input)).bytes)).toEqual(f.bytes);
  } finally {
    await first.return(undefined);
    await second.return(undefined);
    await client.close();
    await f.close();
  }
});

test("aborted paused originals release listener admission before their consumer resumes", async () => {
  const f = await setup();
  const client = new Client({ ...f.options, limits: { listeners: 2 } });
  const paused: AsyncGenerator<import("@ace/client/attachments").AttachmentFrame>[] = [];
  try {
    await client.start();
    await expect.poll(() => client.state).toBe("ready");
    for (let index = 0; index < 4; index++) {
      const controller = new AbortController();
      const frames = client.attachmentChunks(f.input, { signal: controller.signal });
      paused.push(frames);
      expect((await frames.next()).value).toEqual({ bytes: f.bytes.length, mimeType: "image/png" });
      controller.abort();
    }
    expect(Buffer.from((await client.attachmentBytes(f.input)).bytes)).toEqual(f.bytes);
    expect(client.state).toBe("ready");
  } finally {
    for (const frames of paused) await frames.return(undefined);
    await client.close();
    await f.close();
  }
});
