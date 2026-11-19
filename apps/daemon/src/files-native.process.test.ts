// Reason: the socket contract for list.folder, files.watch, search and quick open only holds end to end, through a real daemon and a real ace-files.
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { connectClientViaRelay, startRelay } from "@ace/relay";
import { ServerMessage, ThreadId } from "@ace/protocol";
import { startDaemon, createDevThread } from "./index.ts";
import { findFilesBinary } from "./files-tool/tool.ts";
import { noProviderDiscovery } from "./testing/no-provider-discovery.ts";

const exec = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

type Message = Record<string, unknown>;

/** Replies to what this test sends; anything else the daemon pushes is left alone. */
class Inbox {
  readonly socket: WebSocket;
  #queue: Message[] = [];
  #waiters: { test: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Message;
      const waiting = this.#waiters.findIndex((waiter) => waiter.test(message));
      if (waiting >= 0) this.#waiters.splice(waiting, 1)[0]?.resolve(message);
      else this.#queue.push(message);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  next(test: (message: Message) => boolean): Promise<Message> {
    const queued = this.#queue.findIndex(test);
    if (queued >= 0) {
      const [message] = this.#queue.splice(queued, 1);
      if (message) return Promise.resolve(message);
    }
    return new Promise((resolve) => this.#waiters.push({ test, resolve }));
  }

  files(requestId: string): Promise<Message> {
    return this.next(
      (message) =>
        (message.type === "files.result" || message.type === "files.error") &&
        message.requestId === requestId,
    );
  }
}

/** A relayed client's replies, read through one pump so no two reads race. */
class RemoteInbox {
  #queue: ServerMessage[] = [];
  #waiters: {
    test: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
  }[] = [];

  constructor(remote: Awaited<ReturnType<typeof connectClientViaRelay>>) {
    void (async () => {
      try {
        for (;;) {
          const message = ServerMessage.parse(await remote.receive());
          const waiting = this.#waiters.findIndex((waiter) => waiter.test(message));
          if (waiting >= 0) this.#waiters.splice(waiting, 1)[0]?.resolve(message);
          else this.#queue.push(message);
        }
      } catch {
        // The client closed; there is nothing left to read.
      }
    })();
  }

  next(test: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const queued = this.#queue.findIndex(test);
    if (queued >= 0) {
      const [message] = this.#queue.splice(queued, 1);
      if (message) return Promise.resolve(message);
    }
    return new Promise((resolve) => this.#waiters.push({ test, resolve }));
  }
}

function delay(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One daemon around a checkout with a thread, optionally reachable through a relay. */
async function boot(options: { relayUrl?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-files-native-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "workspace");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "hello.ts"), "export const hello = 1;\n");
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config: {
      dataDir: join(home, "data"),
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "silent",
      ...(options.relayUrl ? { relayUrl: options.relayUrl } : {}),
    },
  });
  cleanup.push(() => daemon.close());
  const workspace = daemon.store.createWorkspace(root, "Workspace");
  const thread = createDevThread(daemon.store, workspace);
  return { home, root, daemon, thread };
}

/** A host-credential socket on the daemon's main port. */
async function connect(daemon: Awaited<ReturnType<typeof boot>>["daemon"]) {
  const client = new Inbox(new WebSocket(daemon.url));
  cleanup.push(() => {
    client.socket.terminate();
    return Promise.resolve();
  });
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: "files-native-test",
    token: (await readFile(daemon.tokenPath, "utf8")).trim(),
  });
  expect(await client.next((message) => message.type === "welcome")).toMatchObject({
    type: "welcome",
  });
  return client;
}

describe.skipIf(!findFilesBinary())("the daemon's ace-files over its socket", () => {
  it("lists a folder, reports a changed folder and answers quick open", async () => {
    const { root, daemon, thread } = await boot();
    const client = await connect(daemon);

    client.send({
      type: "files.request",
      requestId: "list-root",
      threadId: thread.id,
      operation: { op: "list.folder", path: "" },
    });
    expect(await client.files("list-root")).toMatchObject({
      type: "files.result",
      value: { nextCursor: null },
    });
    client.send({
      type: "files.request",
      requestId: "list-src",
      threadId: thread.id,
      operation: { op: "list.folder", path: "src" },
    });
    expect(await client.files("list-src")).toMatchObject({
      type: "files.result",
      value: {
        entries: [{ name: "hello.ts", path: "src/hello.ts", kind: "file", ignored: false }],
        nextCursor: null,
      },
    });

    client.send({ type: "files.watch", threadId: thread.id, folders: ["src"] });
    const changed = client.next((message) => message.type === "files.folders_changed");
    for (let attempt = 0; attempt < 50; attempt++) {
      await writeFile(join(root, "src", `watch-${attempt}.ts`), "export const later = 1;\n");
      if (await Promise.race([changed.then(() => true), delay(100).then(() => false)])) break;
    }
    expect(await changed).toMatchObject({
      type: "files.folders_changed",
      threadId: thread.id,
      folders: ["src"],
      rescan: false,
    });

    let paths: string[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      client.send({
        type: "context.request",
        requestId: "quick-open",
        operation: {
          op: "mention.complete",
          threadId: ThreadId.parse(thread.id),
          query: "hello",
          limit: 50,
        },
      });
      const reply = await client.next(
        (message) => message.type === "context.result" && message.requestId === "quick-open",
      );
      const result = reply.result as { kind?: string; paths?: unknown };
      if (result.kind === "completion" && Array.isArray(result.paths)) {
        paths = result.paths.filter((path): path is string => typeof path === "string");
        if (paths.includes("src/hello.ts")) break;
      }
      await delay(100);
    }
    expect(paths).toContain("src/hello.ts");
  }, 25_000);

  it("answers the legacy list and a folder mention from ace-files", async () => {
    const { root, daemon, thread } = await boot();
    await exec("git", ["init", "--quiet", root]);
    await writeFile(join(root, ".gitignore"), "*.log\n");
    await writeFile(join(root, "src", "ignored.log"), "noise\n");
    const client = await connect(daemon);
    client.send({
      type: "files.request",
      requestId: "legacy-list",
      threadId: thread.id,
      operation: { op: "list", path: "", limit: 1000 },
    });
    const listing = await client.files("legacy-list");
    expect(listing).toMatchObject({ type: "files.result", value: { truncated: false } });
    const paths = (listing.value as { paths: string[] }).paths;
    expect(paths).toEqual(expect.arrayContaining(["src/", "src/hello.ts"]));
    expect(paths).not.toContain("src/ignored.log");

    client.send({
      type: "context.request",
      requestId: "folder-mention",
      operation: {
        op: "mention.resolve",
        threadId: ThreadId.parse(thread.id),
        mentions: [{ path: "src" }],
      },
    });
    const reply = await client.next(
      (message) => message.type === "context.result" && message.requestId === "folder-mention",
    );
    expect(reply).toMatchObject({
      result: {
        kind: "mentions",
        entries: [{ path: "src", text: expect.stringContaining("src/hello.ts") }],
      },
    });
    expect(JSON.stringify(reply)).not.toContain("ignored.log");
  }, 25_000);

  it("refuses listings for a thread that is not live and in the support scope", async () => {
    const { daemon } = await boot();
    const client = await connect(daemon);
    client.send({
      type: "files.request",
      requestId: "missing",
      threadId: ThreadId.parse("gone-thread"),
      operation: { op: "list.folder", path: "" },
    });
    expect(await client.files("missing")).toMatchObject({ type: "files.error" });
    client.send({
      type: "files.request",
      requestId: "support",
      scope: "support",
      operation: { op: "list.folder", path: "" },
    });
    expect(await client.files("support")).toMatchObject({
      type: "files.error",
      code: "FORBIDDEN",
    });
  });

  it("streams search matches, skips ignored files unless asked, and stops a cancelled search", async () => {
    const { root, daemon, thread } = await boot();
    await exec("git", ["init", "--quiet", root]);
    await writeFile(join(root, ".gitignore"), "*.log\n");
    await writeFile(join(root, "src", "ignored.log"), "needle in the log\n");
    await writeFile(join(root, "src", "wide.ts"), "const é = 'needle';\nneedle();\n");
    await writeFile(join(root, "README.md"), "no match here\n");
    const client = await connect(daemon);
    const search = async (requestId: string, operation: Record<string, unknown>) => {
      const matches: Message[] = [];
      const collecting = (async () => {
        for (;;) {
          const message = await client.next(
            (candidate) =>
              (candidate.type === "files.search.matches" && candidate.searchId === requestId) ||
              ((candidate.type === "files.result" || candidate.type === "files.error") &&
                candidate.requestId === requestId),
          );
          if (message.type !== "files.search.matches") return message;
          matches.push(message);
        }
      })();
      client.send({
        type: "files.request",
        requestId,
        threadId: thread.id,
        operation: { op: "search", ...operation },
      });
      const end = await collecting;
      const lines = matches.flatMap(
        (message) => message.files as { path: string; lines: unknown[] }[],
      );
      return { end, lines };
    };

    const plain = await search("needle", { pattern: "needle" });
    expect(plain.end).toMatchObject({
      type: "files.result",
      value: { files: 1, matches: 2, truncated: false },
    });
    expect(plain.lines).toEqual([
      {
        path: "src/wide.ts",
        lines: [
          // "é" is two bytes in the file and one UTF-16 unit in the preview's ranges.
          { line: 1, column: 0, preview: "const é = 'needle';", ranges: [[11, 17]] },
          { line: 2, column: 0, preview: "needle();", ranges: [[0, 6]] },
        ],
      },
    ]);

    const ignored = await search("ignored", { pattern: "needle", includeIgnored: true });
    expect(ignored.lines.map((file) => file.path).toSorted()).toEqual([
      "src/ignored.log",
      "src/wide.ts",
    ]);

    const capped = await search("capped", { pattern: "needle", maxMatches: 1 });
    expect(capped.end).toMatchObject({ type: "files.result", value: { truncated: true } });

    // Sent with its abort in one go: the search never gets to report a match.
    const cancelled = search("cancelled", { pattern: "needle" });
    client.send({ type: "files.abort", sourceRequestId: "cancelled" });
    expect((await cancelled).end).toMatchObject({ type: "files.error", code: "CANCELLED" });

    client.send({
      type: "files.request",
      requestId: "elsewhere",
      threadId: ThreadId.parse("gone-thread"),
      operation: { op: "search", pattern: "needle" },
    });
    expect(await client.files("elsewhere")).toMatchObject({ type: "files.error" });
    client.send({
      type: "files.request",
      requestId: "support-search",
      scope: "support",
      operation: { op: "search", pattern: "needle" },
    });
    expect(await client.files("support-search")).toMatchObject({
      type: "files.error",
      code: "FORBIDDEN",
    });
  }, 25_000);

  it("serves a paired phone's folder listing and watch over the relay", async () => {
    const relay = await startRelay();
    cleanup.push(() => relay.close());
    const { root, daemon, thread } = await boot({ relayUrl: relay.url });
    const hostId = daemon.relayHostId;
    const fingerprint = daemon.relayFingerprint;
    if (!hostId || !fingerprint) throw new Error("No relay endpoint on the daemon");
    const paired = daemon.store.devices.create("Phone", ["read"], 1);
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
      channel: "files",
    });
    const inbox = new RemoteInbox(remote);
    expect(await inbox.next((message) => message.type === "welcome")).toMatchObject({
      type: "welcome",
    });
    await remote.send({
      type: "files.request",
      requestId: "relay-list",
      threadId: thread.id,
      operation: { op: "list.folder", path: "src", limit: 500 },
    });
    expect(await inbox.next((message) => message.type.startsWith("files."))).toMatchObject({
      type: "files.result",
      value: { entries: [{ path: "src/hello.ts" }] },
    });

    await remote.send({
      type: "files.request",
      requestId: "relay-search",
      threadId: thread.id,
      operation: { op: "search", pattern: "hello" },
    });
    expect(
      await inbox.next(
        (message) => message.type === "files.search.matches" && message.searchId === "relay-search",
      ),
    ).toMatchObject({ files: [{ path: "src/hello.ts", lines: [{ line: 1 }] }] });
    expect(
      await inbox.next(
        (message) => message.type === "files.result" || message.type === "files.error",
      ),
    ).toMatchObject({ type: "files.result", requestId: "relay-search", value: { files: 1 } });

    await remote.send({ type: "files.watch", threadId: thread.id, folders: ["src"] });
    const changed = inbox.next((message) => message.type === "files.folders_changed");
    for (let attempt = 0; attempt < 50; attempt++) {
      await writeFile(join(root, "src", `relay-${attempt}.ts`), "export const relayed = 1;\n");
      if (await Promise.race([changed.then(() => true), delay(100).then(() => false)])) break;
    }
    expect(await changed).toMatchObject({
      type: "files.folders_changed",
      threadId: thread.id,
      folders: ["src"],
    });
  }, 25_000);
});
