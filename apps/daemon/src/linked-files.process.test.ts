import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { ClientMessage, FilesServerMessage, Item, ServerMessage } from "@ace/protocol";
import { startRelay, connectClientViaRelay } from "@ace/relay";
import { startDaemon, createDevThread } from "./index.ts";

/*
 * A phone opens a file an agent linked in its answer, even when the file sits outside the
 * project (Desktop, Downloads). The message is the grant: only targets it links are served.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

type Wire = { send(value: unknown): Promise<void>; next(): Promise<FilesServerMessage> };

function fileReply(input: unknown): FilesServerMessage | undefined {
  const parsed = FilesServerMessage.safeParse(input);
  return parsed.success && parsed.data.type !== "files.changed" ? parsed.data : undefined;
}

async function localWire(url: string, deviceId: string, token: string): Promise<Wire> {
  const socket = new WebSocket(url);
  const queue: unknown[] = [];
  const waiters: ((value: unknown) => void)[] = [];
  socket.on("message", (data) => {
    const value: unknown = JSON.parse(data.toString());
    const waiting = waiters.shift();
    if (waiting) waiting(value);
    else queue.push(value);
  });
  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise<unknown>((resolve) => waiters.push(resolve));
  cleanup.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const ended = once(socket, "close");
    socket.terminate();
    await ended;
  });
  await once(socket, "open");
  const { ticket } = z.object({ ticket: z.string() }).parse(
    await (
      await fetch(url.replace(/^ws:/, "http:") + "/v1/tickets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json(),
  );
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId, ticket }));
  expect(ServerMessage.parse(await next())).toMatchObject({ type: "welcome" });
  return {
    send: async (value) => socket.send(JSON.stringify(value)),
    async next() {
      for (;;) {
        const reply = fileReply(await next());
        if (reply) return reply;
      }
    },
  };
}

async function setup(transport: "websocket" | "relay") {
  const home = await mkdtemp(join(tmpdir(), "ace-linked-files-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "project");
  const downloads = join(home, "Downloads");
  await mkdir(project, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const pdf = join(downloads, "Assignment I.pdf");
  await writeFile(pdf, "%PDF-1.7 assignment\n");
  await writeFile(join(downloads, "notes.txt"), "plain notes\n");
  await writeFile(join(home, "secret.txt"), "never linked\n");
  const relay = transport === "relay" ? await startRelay() : undefined;
  if (relay) cleanup.push(() => relay.close());
  const daemon = await startDaemon({
    config: {
      dataDir: join(home, "data"),
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "silent",
      ...(relay ? { relayUrl: relay.url } : {}),
    },
  });
  cleanup.push(() => daemon.close());
  const workspaceId = daemon.store.createWorkspace(project, "Project");
  const thread = createDevThread(daemon.store, workspaceId);
  const message = (id: string, role: "user" | "assistant", text: string) =>
    daemon.store.appendEvents(thread.id, [
      {
        type: "item.created",
        item: Item.parse({
          type: "message",
          id,
          agentId: "root",
          createdAt: 1,
          role,
          complete: true,
          parts: [{ type: "text", text }],
        }),
      },
    ]);
  const paired = daemon.store.devices.create("Phone", ["read"], 1);
  let wire: Wire;
  if (relay) {
    const hostId = daemon.relayHostId;
    const fingerprint = daemon.relayFingerprint;
    if (!hostId || !fingerprint) throw new Error("No relay endpoint");
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
    wire = {
      send: (value) => remote.send(ClientMessage.parse(value)),
      async next() {
        for (;;) {
          const reply = fileReply(await remote.receive());
          if (reply) return reply;
        }
      },
    };
  } else wire = await localWire(daemon.url, paired.device.id, paired.token);
  let request = 0;
  /** The file's text, or the daemon's refusal. */
  const open = async (itemId: string, reference: string) => {
    await wire.send({
      type: "files.request",
      requestId: `link-${++request}`,
      threadId: thread.id,
      operation: { op: "link.download", itemId, reference, offset: 0 },
    });
    const ready = await wire.next();
    if (ready.type !== "files.ready") return ready;
    const chunks: Buffer[] = [];
    for (;;) {
      await wire.send({ type: "files.pull", requestId: "pull", channel: ready.channel });
      const data = await wire.next();
      if (data.type !== "files.data") return data;
      chunks.push(Buffer.from(data.data, "base64"));
      if (data.eof) return Buffer.concat(chunks).toString();
    }
  };
  return { home, downloads, pdf, daemon, thread, paired, wire, message, open };
}

for (const transport of ["websocket", "relay"] as const) {
  it(`a read-only ${transport} device opens files an answer links from outside the project`, async () => {
    const f = await setup(transport);
    const url = pathToFileURL(join(f.downloads, "notes.txt")).href;
    f.message(
      "answer",
      "assistant",
      `Here is [the assignment](<${f.pdf}>) and [your notes](${url}).`,
    );
    expect(await f.open("answer", f.pdf)).toBe("%PDF-1.7 assignment\n");
    expect(await f.open("answer", url)).toBe("plain notes\n");
  });
}

it("only targets the answer links are served, never a path the client picks", async () => {
  const f = await setup("websocket");
  const secret = join(f.home, "secret.txt");
  f.message("answer", "assistant", `See [the key](${secret}.pub) and the path ${f.pdf}.`);
  for (const reference of [secret, f.pdf, `${f.downloads}/../secret.txt`])
    expect(await f.open("answer", reference)).toMatchObject({
      type: "files.error",
      code: "FORBIDDEN",
    });
});

it("a link in the person's own message grants nothing", async () => {
  const f = await setup("websocket");
  f.message("question", "user", `Open [this](<${f.pdf}>)`);
  expect(await f.open("question", f.pdf)).toMatchObject({
    type: "files.error",
    code: "NOT_FOUND",
  });
});

it("a revoked device loses a linked file it was reading", async () => {
  const f = await setup("websocket");
  f.message("answer", "assistant", `[Assignment](<${f.pdf}>)`);
  await f.wire.send({
    type: "files.request",
    requestId: "link",
    threadId: f.thread.id,
    operation: { op: "link.download", itemId: "answer", reference: f.pdf, offset: 0 },
  });
  const ready = await f.wire.next();
  if (ready.type !== "files.ready") throw new Error(`Unexpected ${ready.type}`);
  f.daemon.store.devices.revoke(f.paired.device.id, 2);
  await f.wire.send({ type: "files.pull", requestId: "pull", channel: ready.channel });
  expect(await f.wire.next()).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
});
