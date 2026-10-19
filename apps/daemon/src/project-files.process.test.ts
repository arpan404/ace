import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { ClientMessage, FilesServerMessage, ServerMessage, WorkspaceId } from "@ace/protocol";
import { startRelay, connectClientViaRelay } from "@ace/relay";
import { startDaemon, createDevThread } from "./index.ts";
import { ProjectStorage } from "./project-storage.ts";

/*
 * New thread on a phone browses a registered project's own folder before any thread exists:
 * `files.request` with `workspaceId`, read-only, confined to the project root, for a paired
 * device holding only a read grant, over a local socket and through the relay.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

type Wire = { send(value: unknown): Promise<void>; next(): Promise<FilesServerMessage> };

/** Only file replies; the daemon's own broadcasts are skipped. */
function fileReply(input: unknown): FilesServerMessage | undefined {
  const parsed = FilesServerMessage.safeParse(input);
  return parsed.success && parsed.data.type !== "files.changed" ? parsed.data : undefined;
}

class Socket {
  readonly socket: WebSocket;
  private queue: unknown[] = [];
  private waiters: ((value: unknown) => void)[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data) => {
      const value: unknown = JSON.parse(data.toString());
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
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const ended = once(this.socket, "close");
    this.socket.terminate();
    await ended;
  }
}

async function setup(transport: "websocket" | "relay") {
  const home = await mkdtemp(join(tmpdir(), "ace-project-files-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "README.md"), "# Project\n");
  await writeFile(join(project, "src", "main.ts"), "export const answer = 42;\n");
  await writeFile(join(home, "secret.txt"), "outside the project\n");
  await symlink(join(home, "secret.txt"), join(project, "escape.txt"));
  await symlink(home, join(project, "escape-dir"));
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
  } else {
    const local = new Socket(daemon.url);
    cleanup.push(() => local.close());
    await once(local.socket, "open");
    const { ticket } = z.object({ ticket: z.string() }).parse(
      await (
        await fetch(daemon.url.replace(/^ws:/, "http:") + "/v1/tickets", {
          method: "POST",
          headers: { Authorization: `Bearer ${paired.token}` },
        })
      ).json(),
    );
    local.socket.send(
      JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: paired.device.id, ticket }),
    );
    expect(ServerMessage.parse(await local.next())).toMatchObject({ type: "welcome" });
    wire = {
      send: async (value) => local.socket.send(JSON.stringify(value)),
      async next() {
        for (;;) {
          const reply = fileReply(await local.next());
          if (reply) return reply;
        }
      },
    };
  }
  const request = async (operation: unknown, scope: object = { workspaceId }) => {
    await wire.send({ type: "files.request", requestId: "project", ...scope, operation });
    return wire.next();
  };
  const download = async (path: string) => {
    const ready = await request({ op: "download", path, offset: 0 });
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
  return { home, project, daemon, workspaceId, paired, wire, request, download };
}

for (const transport of ["websocket", "relay"] as const) {
  it(`a read-only ${transport} device lists and previews a project's folder before any thread exists`, async () => {
    const f = await setup(transport);
    const listed = await f.request({ op: "list", path: "", limit: 1000 });
    expect(listed).toMatchObject({ type: "files.result" });
    const paths = z
      .object({ value: z.object({ paths: z.array(z.string()), truncated: z.boolean() }) })
      .parse(listed).value;
    expect(paths.paths.toSorted()).toEqual(["README.md", "src/", "src/main.ts"]);
    expect(paths.truncated).toBe(false);
    expect(await f.download("src/main.ts")).toBe("export const answer = 42;\n");
  });

  it(`a ${transport} device can't write to a project's folder through the project scope`, async () => {
    const f = await setup(transport);
    for (const operation of [
      { op: "create", path: "new.txt", expected: null, text: "bad" },
      { op: "write", path: "README.md", expected: null, text: "bad" },
      { op: "mkdir", path: "made", expected: null },
      { op: "delete", path: "README.md", expected: null },
      { op: "upload.begin", path: "upload.bin", expected: null, size: 1 },
      { op: "archive.preview", path: "", includeIgnored: false },
    ])
      expect(await f.request(operation)).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
    await expect(stat(join(f.project, "new.txt"))).rejects.toThrow();
    await expect(stat(join(f.project, "made"))).rejects.toThrow();
    expect(await readFile(join(f.project, "README.md"), "utf8")).toBe("# Project\n");
  });
}

it("project reads stay inside the project root: parent paths, absolute paths, NUL bytes and symlinks out are refused", async () => {
  const f = await setup("websocket");
  for (const path of [
    "../secret.txt",
    "src/../../secret.txt",
    join(f.home, "secret.txt"),
    "README.md\0",
    "escape.txt",
    "escape-dir/secret.txt",
  ])
    expect(await f.download(path)).toMatchObject({ type: "files.error" });
  for (const path of ["..", "../", join(f.home), "escape-dir"])
    expect(await f.request({ op: "list", path, limit: 1000 })).toMatchObject({
      type: "files.error",
    });
  const listed = z
    .object({ value: z.object({ paths: z.array(z.string()) }) })
    .parse(await f.request({ op: "list", path: "", limit: 1000 })).value.paths;
  expect(listed.some((path) => path.includes("secret") || path.startsWith("escape"))).toBe(false);
});

it("an unknown, removed or doubly scoped project is refused, and a removal ends an open preview", async () => {
  const f = await setup("websocket");
  expect(
    await f.request(
      { op: "list", path: "", limit: 10 },
      { workspaceId: WorkspaceId.parse("missing") },
    ),
  ).toMatchObject({ type: "files.error", code: "NOT_FOUND" });
  const thread = createDevThread(f.daemon.store, f.workspaceId);
  expect(
    await f.request(
      { op: "list", path: "", limit: 10 },
      { workspaceId: f.workspaceId, threadId: thread.id },
    ),
  ).toMatchObject({ type: "files.error", code: "INVALID_MESSAGE" });
  const ready = await f.request({ op: "download", path: "README.md", offset: 0 });
  if (ready.type !== "files.ready") throw new Error(`Unexpected ${ready.type}`);
  new ProjectStorage(f.daemon.store, () => 2).remove(f.workspaceId, true, () => false);
  await f.wire.send({ type: "files.pull", requestId: "pull", channel: ready.channel });
  expect(await f.wire.next()).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
  expect(await f.request({ op: "list", path: "", limit: 10 })).toMatchObject({
    type: "files.error",
    code: "NOT_FOUND",
  });
});

it("a revoked device loses an open project preview", async () => {
  const f = await setup("websocket");
  const ready = await f.request({ op: "download", path: "README.md", offset: 0 });
  if (ready.type !== "files.ready") throw new Error(`Unexpected ${ready.type}`);
  f.daemon.store.devices.revoke(f.paired.device.id, 2);
  await f.wire.send({ type: "files.pull", requestId: "pull", channel: ready.channel });
  expect(await f.wire.next()).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
});
