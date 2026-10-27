import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { preparePairing } from "../pairing/pairing-flow.ts";
import type { Storage } from "@ace/client";
import { createProductionStartup, type StartupDatabase } from "../runtime/production-startup.ts";
import { productionFilesClient } from "./production-files.ts";
import { downloadCopy, listTree, readFileContent } from "../files.ts";

/*
 * Production file browsing: the open thread's checkout tree plus one file at
 * a time through the read-only handle. No grant check runs (view-only reads
 * on), mutations and foreign scopes are refused before the socket, and the
 * raw client never escapes the adapter. Android only.
 */

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const TICKET = "f1".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const THREAD = "thread-1";
const OTHER = "thread-9";
const NOTE = "notes.txt";
const BODY = "hello files\n";
const PATCH = [
  "diff --git a/notes.txt b/notes.txt",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -1 +1 @@",
  "-old",
  "+hello files",
  "",
].join("\n");

function memoryStorage(): Storage {
  const meta = new Map<string, string>();
  const records = new Map<string, string>();
  return {
    load: async () => meta.get("legacy") ?? null,
    save: async (value) => {
      meta.set("legacy", value);
    },
    hostBinding: {
      load: async () => meta.get("host") ?? null,
      save: async (value) => {
        meta.set("host", value);
      },
    },
    records: {
      load: async () => [...records.values()],
      write: async (id, value) => {
        if (value === null) records.delete(id);
        else records.set(id, value);
      },
    },
  };
}

function memoryDatabase(): StartupDatabase {
  const namespaces = new Map<string, { meta: Map<string, string>; records: Map<string, string> }>();
  let grants: Record<string, string[]> | null = null;
  return {
    ensureOutboxTables: async () => {},
    deleteNamespace: async (namespace) => {
      namespaces.delete(namespace);
    },
    storageFor: (namespace) => {
      let scope = namespaces.get(namespace);
      if (scope === undefined) {
        scope = { meta: new Map(), records: new Map() };
        namespaces.set(namespace, scope);
      }
      return {
        load: async () => scope.meta.get("legacy") ?? null,
        save: async (value) => {
          scope.meta.set("legacy", value);
        },
        hostBinding: {
          load: async () => scope.meta.get("host") ?? null,
          save: async (value) => {
            scope.meta.set("host", value);
          },
        },
        records: {
          load: async () => [...scope.records.values()],
          write: async (id, value) => {
            if (value === null) scope.records.delete(id);
            else scope.records.set(id, value);
          },
        },
      };
    },
    grants: {
      load: async () => grants,
      save: async (next) => {
        grants = structuredClone(next);
      },
    },
  };
}

/** A daemon that accepts the stubbed single-use ticket instead of a token. */
class TicketDaemon extends FakeDaemon {
  override accepts(offered: { token?: string | undefined; ticket?: string | undefined }) {
    return offered.ticket === TICKET;
  }
}

function daemonBridge(): ExpoPinnedBridge {
  return {
    pinnedFetch: async (input) => {
      if (input.method === "POST" && input.path === "/v1/pair")
        return {
          status: 200,
          body: JSON.stringify({
            device: {
              id: "device-1",
              name: "My phone",
              scopes: ["read", "operate"],
              createdAt: 1,
              lastSeenAt: 1,
              revokedAt: null,
            },
            token: TOKEN,
          }),
        };
      if (input.path === "/v1/tickets")
        return {
          status: 200,
          body: JSON.stringify({ ticket: TICKET, expiresAt: Date.now() + 60_000 }),
        };
      return { status: 404, body: "{}" };
    },
    pinnedSocketOpen: () => {},
    pinnedSocketSend: () => {},
    pinnedSocketClose: () => {},
    addSocketListener: () => () => {},
  };
}

async function until(
  done: () => boolean,
  message = "Timed out waiting for the daemon.",
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (done()) return;
    if (Date.now() - started > 15_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function liveStartup(daemon: FakeDaemon) {
  return createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database: memoryDatabase(),
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => fakeTransport(daemon),
  });
}

function seedFiles(fake: FakeDaemon): void {
  fake.checkouts.seed(THREAD, NOTE, BODY);
  fake.workspace.setGitStatus(THREAD, [
    { path: NOTE, status: "modified", additions: 1, deletions: 1, binary: false },
  ]);
  fake.workspace.setGitDiff(THREAD, PATCH);
}

async function pairLive(daemon: FakeDaemon) {
  const produced = liveStartup(daemon);
  expect(await produced.load()).toEqual([]);
  daemon.createThread({ id: THREAD, workspaceId: "ace", title: "T", provider: "codex" });
  seedFiles(daemon);
  const confirmed = preparePairing(LINK);
  await produced.pair(confirmed, "My phone");
  expect(produced.canOperate("host-1")).toBe(true);
  return produced;
}

function adapterOf(produced: Awaited<ReturnType<typeof pairLive>>) {
  return productionFilesClient(produced.runtimeForReading("host-1"), THREAD);
}

async function ready(produced: Awaited<ReturnType<typeof pairLive>>) {
  const reads = produced.runtimeForReading("host-1");
  await until(() => reads.connectionState().getSnapshot() === "ready");
}

it("reads the open thread's tree and file through the adapter, with git marks", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    const files = adapterOf(produced);
    const signal = new AbortController().signal;
    const tree = await listTree(files, { threadId: THREAD }, signal);
    expect(tree.rows.map((entry) => entry.path)).toContain(NOTE);
    expect(tree.rows.find((entry) => entry.path === NOTE)).toMatchObject({ mark: "M" });
    const file = await readFileContent(files, { threadId: THREAD }, NOTE, signal);
    if (file.kind !== "text") throw new Error(`Expected text, read ${file.kind}.`);
    expect(file.text).toBe(BODY);
    expect(file.marks).toContainEqual({ line: 1, kind: "added" });
  } finally {
    await produced.disconnectAll();
  }
});

it("downloads a small file through the adapter without a mutation", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    const files = adapterOf(produced);
    const copy = await downloadCopy(
      files,
      { threadId: THREAD },
      { op: "download", path: NOTE },
      new AbortController().signal,
    );
    expect(copy.name).toBe(NOTE);
    expect(Buffer.from(copy.base64, "base64").toString("utf8")).toBe(BODY);
  } finally {
    await produced.disconnectAll();
  }
});

it("stays readable while view-only", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);
    const files = adapterOf(produced);
    const signal = new AbortController().signal;
    const tree = await listTree(files, { threadId: THREAD }, signal);
    expect(tree.rows.map((entry) => entry.path)).toContain(NOTE);
    const file = await readFileContent(files, { threadId: THREAD }, NOTE, signal);
    if (file.kind !== "text") throw new Error(`Expected text, read ${file.kind}.`);
    expect(file.text).toBe(BODY);
  } finally {
    await produced.disconnectAll();
  }
});

it("refuses every mutation before the socket", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    const files = adapterOf(produced);
    const id = ThreadId.parse(THREAD);
    const options = { signal: new AbortController().signal };
    await expect(
      files.request(
        {
          type: "files.request",
          threadId: id,
          operation: { op: "write", path: NOTE, expected: null, text: "evil" },
        },
        options,
      ),
    ).rejects.toThrow("read-only");
    await expect(
      files.request(
        {
          type: "files.request",
          threadId: id,
          operation: { op: "delete", path: NOTE, expected: null },
        },
        options,
      ),
    ).rejects.toThrow("read-only");
    await expect(
      files.request(
        {
          type: "files.request",
          threadId: id,
          operation: { op: "upload.begin", path: NOTE, expected: null, size: 1 },
        },
        options,
      ),
    ).rejects.toThrow("read-only");
    await expect(
      files.request(
        {
          type: "workspace.request",
          operation: { op: "git.draft.generate", threadId: id, input: { message: "evil" } },
        } as never,
        options,
      ),
    ).rejects.toThrow("read-only");
    expect(() =>
      files.send({ type: "thread.send", threadId: id } as unknown as Parameters<
        typeof files.send
      >[0]),
    ).toThrow("read-only");
  } finally {
    await produced.disconnectAll();
  }
});

it("pins the viewer to its own thread's checkout", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    const files = adapterOf(produced);
    const options = { signal: new AbortController().signal };
    await expect(listTree(files, { threadId: OTHER }, options.signal)).rejects.toThrow(
      "its own thread",
    );
    await expect(
      files.request(
        {
          type: "files.request",
          threadId: ThreadId.parse(OTHER),
          operation: { op: "list", path: "", limit: 1000 },
        },
        options,
      ),
    ).rejects.toThrow("its own thread");
    await expect(
      files.request(
        {
          type: "workspace.request",
          operation: { op: "git.status", threadId: ThreadId.parse(OTHER) },
        },
        options,
      ),
    ).rejects.toThrow("its own thread");
  } finally {
    await produced.disconnectAll();
  }
});

it("exposes no raw client: allowlisted request/send plus filtered taps only", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    const files = adapterOf(produced);
    expect(Object.keys(files).toSorted()).toEqual(
      ["cachedThread", "connectionState", "onMessage", "request", "send", "state"].toSorted(),
    );
    const raw = files as unknown as Record<string, unknown>;
    for (const key of [
      "client",
      "enqueue",
      "command",
      "submitNew",
      "threads",
      "thread",
      "intent",
      "start",
      "close",
      "registry",
    ]) {
      expect(raw[key], `files[${key}]`).toBeUndefined();
      expect(key in files, `files has ${key}`).toBe(false);
    }
    const stop = files.onMessage(() => {});
    expect(typeof stop).toBe("function");
    stop();
  } finally {
    await produced.disconnectAll();
  }
});

it("rejects shape-invalid pull and cancel before the socket", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const database = memoryDatabase();
  const produced = createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database,
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => {
      const inner = fakeTransport(daemon);
      return {
        open: (events) => inner.open(events),
        send: (text) => {
          sent.push(text);
          inner.send(text);
        },
        close: () => inner.close(),
      };
    },
  });
  expect(await produced.load()).toEqual([]);
  daemon.createThread({ id: THREAD, workspaceId: "ace", title: "T", provider: "codex" });
  seedFiles(daemon);
  await produced.pair(preparePairing(LINK), "My phone");
  try {
    await ready(produced);
    const files = adapterOf(produced);
    const options = { signal: new AbortController().signal };
    const before = sent.length;
    // Missing channel, zero/out-of-range/non-integer channels, and unknown
    // one-way types must all throw before the socket.
    for (const bad of [
      { type: "files.pull", requestId: "r" },
      { type: "files.pull", requestId: "r", channel: 0 },
      { type: "files.pull", requestId: "r", channel: -1 },
      { type: "files.pull", requestId: "r", channel: 1.5 },
      { type: "files.pull", requestId: "r", channel: "1" },
      { type: "files.pull", requestId: "r", channel: 0xffffffff + 1 },
    ]) {
      await expect(files.request(bad as never, options)).rejects.toThrow("read-only");
    }
    for (const bad of [
      { type: "files.cancel" },
      { type: "files.cancel", channel: 0 },
      { type: "files.cancel", channel: "1" },
      { type: "files.credit", channel: 1, credits: 1 },
      { type: "files.abort", sourceRequestId: "r" },
    ]) {
      expect(() => files.send(bad as never)).toThrow("read-only");
    }
    // Malformed request shapes with an allowlisted op still throw here.
    await expect(
      files.request({ type: "files.request", threadId: ThreadId.parse(THREAD) } as never, options),
    ).rejects.toThrow("read-only");
    expect(sent.length).toBe(before);
  } finally {
    await produced.disconnectAll();
  }
});

it("pins cachedThread to the open thread", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    const files = adapterOf(produced);
    // Warm the snapshot so the own-thread read has something to return.
    await listTree(files, { threadId: THREAD }, new AbortController().signal);
    expect(files.cachedThread?.(THREAD)?.thread?.id ?? THREAD).toBe(THREAD);
    expect(() => files.cachedThread?.(OTHER)).toThrow("its own thread");
  } finally {
    await produced.disconnectAll();
  }
});

it("fails the file viewer closed after device removal", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    const files = adapterOf(produced);
    const signal = new AbortController().signal;
    await listTree(files, { threadId: THREAD }, signal);
    await produced.remove("host-1");
    await expect(listTree(files, { threadId: THREAD }, signal)).rejects.toThrow("not connected");
    expect(() => files.send({ type: "files.cancel", channel: 1 })).toThrow("not connected");
    expect(() => files.onMessage(() => {})).toThrow("not connected");
    expect(() => files.cachedThread?.(THREAD)).toThrow("not connected");
  } finally {
    await produced.disconnectAll();
  }
});
it("fails closed after disconnect and same-host replacement", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    await ready(produced);
    const files = adapterOf(produced);
    const signal = new AbortController().signal;
    expect(files.state).toBe("ready");
    await produced.disconnectAll();
    expect(files.state).toBe("connecting");
    await expect(listTree(files, { threadId: THREAD }, signal)).rejects.toThrow("not connected");
    expect(() => files.onMessage(() => {})).toThrow("not connected");
  } finally {
    await produced.disconnectAll();
  }

  const daemon2 = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced2 = await pairLive(daemon2);
  try {
    await ready(produced2);
    const stale = adapterOf(produced2);
    const live = produced2.manager.entry("host-1");
    const url = live?.target.kind === "direct" ? live.target.url : "";
    const { MachineEntry } = await import("@ace/client/machines");
    await produced2.manager.connectEntry(
      MachineEntry.parse({
        hostId: "host-1",
        displayName: "host-1",
        target: { kind: "direct", url, fingerprint: "8e".repeat(32) },
        deviceId: "device-1",
      }),
    );
    await expect(
      listTree(stale, { threadId: THREAD }, new AbortController().signal),
    ).rejects.toThrow("not connected");
  } finally {
    await produced2.disconnectAll();
  }
});
