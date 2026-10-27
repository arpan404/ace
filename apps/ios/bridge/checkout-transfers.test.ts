import { until } from "./test-host.ts";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import type { HostRequest } from "@ace/native-host";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId, ThreadId } from "@ace/protocol";
import { CheckoutDownloads } from "./checkout-downloads.ts";
import { CheckoutFiles } from "./checkout-files.ts";
import { CheckoutMemory } from "./checkout-memory.ts";
import { NativeFilesRequest } from "./checkout-request.ts";
import { CheckoutUploads } from "./checkout-uploads.ts";

/*
 * Saving checkout files and folder archives to the phone, and sending picked files into a
 * checkout, over the real SDK and an in-process fake daemon. Swift's side is played by memory:
 * temporary files for `download.*` and staged picks for `attachment.chunk`.
 */

const thread = "ios-transfers";
const scope = { threadId: ThreadId.parse(thread) };
const idle = () => {};
let client: ClientCore | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

type Patch = Record<string, unknown>;
function recorder() {
  const seen: Patch[] = [];
  return {
    seen,
    put: (_key: string, read: () => Patch | undefined) => {
      const value = read();
      if (value) seen.push(value);
    },
    last: (type: string, id: string) =>
      seen.findLast((each) => each.type === type && each.id === id),
  };
}

/**
 * The phone's temporary files, as `DownloadFiles.swift` keeps them. `gate` holds appends;
 * `opening` holds `download.open` before its folder exists, as a slow host does.
 */
function phoneFiles(gate?: Promise<void>, opening?: Promise<void>) {
  const files = new Map<string, { name: string; bytes: Buffer }>();
  const calls: string[] = [];
  const call = (async (
    operation: string,
    input: { id: string } & Record<string, unknown>,
    body?: string,
  ) => {
    calls.push(operation);
    if (operation === "download.open") {
      await opening;
      files.set(input.id, { name: String(input.name), bytes: Buffer.alloc(0) });
      calls.push("opened");
    }
    if (operation === "download.append") {
      await gate;
      const file = files.get(input.id);
      if (!file || file.bytes.length !== input.offset) throw new Error("invalid");
      file.bytes = Buffer.concat([file.bytes, Buffer.from(body ?? "", "base64")]);
    }
    if (operation === "download.finish") return `/tmp/${input.id}/${files.get(input.id)?.name}`;
    if (operation === "download.discard") files.delete(input.id);
    return "";
  }) as unknown as HostRequest;
  let next = 0;
  return { files, calls, door: { call, uuid: () => `file-${++next}` } };
}

/** Picks staged on the phone, read back a chunk at a time. */
function staged(picks: Record<string, Buffer>, onRead?: (offset: number) => Promise<void> | void) {
  const meta = (localId: string, name: string) => {
    const bytes = picks[localId] ?? Buffer.alloc(0);
    return {
      localId,
      name,
      mimeType: "application/octet-stream",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const read = async (localId: string, offset: number, limit: number) => {
    await onRead?.(offset);
    return (picks[localId] ?? Buffer.alloc(0)).subarray(offset, offset + limit).toString("base64");
  };
  return { meta, read };
}

type Wire = Parameters<FakeDaemon["connect"]>[0];

/**
 * The daemon publishes an upload but its reply never arrives: the first `upload.commit` result is
 * dropped and the connection closes, as a network cut at that instant does. `lost` runs then.
 */
function commitReplyLost(fake: FakeDaemon, lost: () => void = idle) {
  let dropped = false;
  return {
    connect(wire: Wire) {
      let commit: unknown;
      const connection = fake.connect({
        ...wire,
        send: (text) => {
          const reply: { type?: unknown; requestId?: unknown } = JSON.parse(text);
          if (!dropped && commit && reply.type === "files.result" && reply.requestId === commit) {
            dropped = true;
            lost();
            fake.disconnectAll();
            return;
          }
          wire.send(text);
        },
      });
      const receive = connection.receive.bind(connection);
      connection.receive = (text) => {
        const sent: { requestId?: unknown; operation?: { op?: unknown } } = JSON.parse(text);
        if (sent.operation?.op === "upload.commit") commit = sent.requestId;
        receive(text);
      };
      return connection;
    },
  };
}

async function connect(
  options: {
    clock?: () => number;
    route?: (fake: FakeDaemon) => { connect(wire: Wire): ReturnType<FakeDaemon["connect"]> };
  } = {},
) {
  const fake = new FakeDaemon({
    clock: options.clock ?? Date.now,
    hostId: "ios-test-host",
    token: "t",
  });
  fake.createThread({ id: thread, workspaceId: "ace", title: "Transfers", provider: "claude" });
  fake.workspace.setDetails(thread, { worktree: "/work/transfers" });
  fake.checkouts.seed(thread, "docs/notes.md", "# Kept on the host\n");
  fake.checkouts.seed(thread, "docs/plan.md", "# Plan\n");
  fake.checkouts.seedBytes(thread, "assets/big.bin", Buffer.alloc(300_000, 7));
  const route = options.route?.(fake) ?? fake;
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-transfers-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(route),
    credential: async () => ({ token: "t" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, Math.min(delay, 20));
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  void owner.start();
  await until(() => owner.state === "ready");
  const memory = new CheckoutMemory(
    { load: async () => undefined, save: async () => {} },
    recorder(),
    { set: () => () => {} },
  );
  const files = new CheckoutFiles(
    owner,
    async () => [],
    (each) => memory.recent(each),
  );
  const ask = (operation: unknown) =>
    files.request(
      NativeFilesRequest.parse({ type: "native.files", scope, operation }),
      new AbortController().signal,
    );
  const text = async (path: string) => {
    const read = await ask({ op: "read", path });
    return read.kind === "text" ? read.text : read.kind;
  };
  return { fake, owner, ask, text, memory };
}

test("a folder's archive previews what goes in, then saves to the phone whole", async () => {
  const { owner, ask } = await connect();
  const preview = await ask({ op: "archive", path: "docs", includeIgnored: false });
  expect(preview).toMatchObject({ ok: true, entries: 2, name: "docs.tar.gz" });
  expect(preview.summary).toMatch(/^2 entries · .+ before compression$/);
  expect(preview.leavesOut).toMatch(/ignores/);

  const sink = recorder();
  const phone = phoneFiles();
  const downloads = new CheckoutDownloads(owner, sink, phone.door);
  downloads.handle({
    type: "files.download",
    id: "archive",
    scope,
    target: { kind: "archive", path: "docs", previewId: String(preview.previewId) },
  });
  const saved = await until(() => {
    const last = sink.last("files.download", "archive");
    return last?.phase === "saved" && last;
  });
  const file = [...phone.files.values()][0];
  expect(file?.name).toBe("docs.tar.gz");
  // A gzip stream, as long as the patch says.
  expect([...(file?.bytes.subarray(0, 2) ?? [])]).toEqual([0x1f, 0x8b]);
  expect(saved).toMatchObject({
    size: file?.bytes.length,
    filePath: expect.stringMatching(/docs\.tar\.gz$/),
  });
});

test("a checkout file saves to the phone in chunks with its size known up front", async () => {
  const { owner } = await connect();
  const sink = recorder();
  const phone = phoneFiles();
  new CheckoutDownloads(owner, sink, phone.door).handle({
    type: "files.download",
    id: "big",
    scope,
    target: { kind: "file", path: "assets/big.bin" },
  });
  await until(() => sink.last("files.download", "big")?.phase === "saved");
  const progress = sink.seen.filter((each) => each.phase === "saving");
  expect(
    progress.some((each) => Number(each.received) > 0 && Number(each.received) < 300_000),
  ).toBe(true);
  expect(progress.at(-1)?.size).toBe(300_000);
  expect([...phone.files.values()][0]?.bytes.equals(Buffer.alloc(300_000, 7))).toBe(true);
});

test("stopping a download leaves no partial file on the phone", async () => {
  const { owner } = await connect();
  const sink = recorder();
  let open: () => void = idle;
  const phone = phoneFiles(new Promise<void>((resolve) => (open = resolve)));
  const downloads = new CheckoutDownloads(owner, sink, phone.door);
  downloads.handle({
    type: "files.download",
    id: "stop",
    scope,
    target: { kind: "file", path: "assets/big.bin" },
  });
  await until(() => phone.files.size === 1);
  downloads.handle({ type: "files.download.cancel", id: "stop" });
  open();
  await until(() => sink.last("files.download", "stop")?.phase === "stopped");
  await until(() => phone.files.size === 0);
});

for (const action of ["files.download.done", "files.download.cancel"] as const)
  test(`${action} while the phone is still opening the file leaves no folder behind`, async () => {
    const { owner } = await connect();
    const sink = recorder();
    let open: () => void = idle;
    const phone = phoneFiles(undefined, new Promise<void>((resolve) => (open = resolve)));
    const downloads = new CheckoutDownloads(owner, sink, phone.door);
    downloads.handle({
      type: "files.download",
      id: "late",
      scope,
      target: { kind: "file", path: "docs/plan.md" },
    });
    await until(() => phone.calls.includes("download.open"));
    downloads.handle({ type: action, id: "late" });
    open();
    // Whatever the order the phone ran them in, the folder is gone once the transfer settles.
    await until(() => phone.calls.includes("opened"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(phone.files.size).toBe(0);
  });

test("an expired archive preview says to choose the download again", async () => {
  const { owner } = await connect();
  const sink = recorder();
  new CheckoutDownloads(owner, sink, phoneFiles().door).handle({
    type: "files.download",
    id: "stale",
    scope,
    target: { kind: "archive", path: "docs", previewId: "gone" },
  });
  const failed = await until(() => {
    const last = sink.last("files.download", "stale");
    return last?.phase === "failed" && last;
  });
  expect(failed.message).toMatch(/Choose Download folder again/);
});

test("picked files go into the folder; one already there waits, then keeps both", async () => {
  const { owner, text } = await connect();
  const sink = recorder();
  const picks = staged({
    aaaaaaaa: Buffer.from("# From the phone\n"),
    bbbbbbbb: Buffer.from("new\n"),
  });
  const uploads = new CheckoutUploads(owner, sink, picks.read);
  uploads.handle({
    type: "files.upload",
    id: "up",
    threadId: scope.threadId,
    folder: "docs/",
    files: [picks.meta("aaaaaaaa", "notes.md"), picks.meta("bbbbbbbb", "fresh.txt")],
  });
  await until(() => sink.last("files.upload", "up")?.phase === "asking");
  uploads.handle({ type: "files.upload.resolve", id: "up", choice: "keepBoth" });
  const done = await until(() => {
    const last = sink.last("files.upload", "up");
    return last?.phase === "done" && last;
  });
  expect(
    (done.items as { path: string; state: string }[]).map((each) => [each.path, each.state]),
  ).toEqual([
    ["docs/notes 2.md", "done"],
    ["docs/fresh.txt", "done"],
  ]);
  expect(await text("docs/notes.md")).toBe("# Kept on the host\n");
  expect(await text("docs/notes 2.md")).toBe("# From the phone\n");
  expect(await text("docs/fresh.txt")).toBe("new\n");
});

test("replace for every file asks once and overwrites each one already there", async () => {
  const { owner, text } = await connect();
  const sink = recorder();
  const picks = staged({ aaaaaaaa: Buffer.from("one\n"), bbbbbbbb: Buffer.from("two\n") });
  const uploads = new CheckoutUploads(owner, sink, picks.read);
  uploads.handle({
    type: "files.upload",
    id: "all",
    threadId: scope.threadId,
    folder: "docs",
    files: [picks.meta("aaaaaaaa", "notes.md"), picks.meta("bbbbbbbb", "plan.md")],
  });
  await until(() => sink.last("files.upload", "all")?.phase === "asking");
  uploads.handle({ type: "files.upload.resolve", id: "all", choice: "replace", all: true });
  await until(() => sink.last("files.upload", "all")?.phase === "done");
  expect(sink.seen.filter((each) => each.phase === "asking")).toHaveLength(1);
  expect(await text("docs/notes.md")).toBe("one\n");
  expect(await text("docs/plan.md")).toBe("two\n");
});

test("an upload cut by a lost connection goes on from what the daemon already stored", async () => {
  const { fake, owner, ask } = await connect();
  const sink = recorder();
  const bytes = Buffer.alloc(240 * 1024, 0);
  let reads = 0;
  const picks = staged({ aaaaaaaa: bytes }, (offset) => {
    // The connection drops after the first two chunks are stored.
    if (offset > 0 && ++reads === 2) fake.disconnectAll();
  });
  new CheckoutUploads(owner, sink, picks.read).handle({
    type: "files.upload",
    id: "cut",
    threadId: scope.threadId,
    folder: "",
    files: [picks.meta("aaaaaaaa", "recording.bin")],
  });
  await until(() => sink.last("files.upload", "cut")?.phase === "done");
  const waited = sink.seen.findIndex((each) => each.phase === "waiting");
  expect(waited).toBeGreaterThan(-1);
  // Never back to the start: the resumed upload begins at the bytes the daemon kept.
  const sent = sink.seen.slice(waited).map((each) => (each.items as { sent: number }[])[0]?.sent);
  expect(Math.min(...sent.map(Number))).toBeGreaterThan(0);
  const read = await ask({ op: "read", path: "recording.bin" });
  expect(read).toMatchObject({ kind: "binary", size: bytes.length });
});

test("an upload whose commit reply is lost ends done, without a conflict or a copy", async () => {
  const { owner, text } = await connect({ route: (fake) => commitReplyLost(fake) });
  const sink = recorder();
  const picks = staged({ aaaaaaaa: Buffer.from("# Sent once\n") });
  new CheckoutUploads(owner, sink, picks.read).handle({
    type: "files.upload",
    id: "lost",
    threadId: scope.threadId,
    folder: "docs",
    files: [picks.meta("aaaaaaaa", "sent.md")],
  });
  const settled = await until(() => {
    const last = sink.last("files.upload", "lost");
    return last && ["done", "asking", "failed"].includes(String(last.phase)) && last;
  });
  expect(settled.phase).toBe("done");
  expect(sink.seen.some((each) => each.phase === "waiting")).toBe(true);
  expect(settled.items).toEqual([expect.objectContaining({ path: "docs/sent.md", state: "done" })]);
  expect(await text("docs/sent.md")).toBe("# Sent once\n");
  expect(await text("docs/sent 2.md")).toBe("missing");
});

test("an upload the daemon no longer remembers ends done when the path holds the same bytes", async () => {
  let now = Date.now();
  const { owner, text } = await connect({
    clock: () => now,
    // Two days pass before the reconnect: the daemon has forgotten the committed upload.
    route: (fake) => commitReplyLost(fake, () => (now += 2 * 86_400_000)),
  });
  const sink = recorder();
  const picks = staged({ aaaaaaaa: Buffer.from("# Sent long ago\n") });
  new CheckoutUploads(owner, sink, picks.read).handle({
    type: "files.upload",
    id: "forgot",
    threadId: scope.threadId,
    folder: "",
    files: [picks.meta("aaaaaaaa", "old.md")],
  });
  const settled = await until(() => {
    const last = sink.last("files.upload", "forgot");
    return last && ["done", "asking", "failed"].includes(String(last.phase)) && last;
  });
  expect(settled.phase).toBe("done");
  expect(settled.items).toEqual([expect.objectContaining({ path: "old.md", state: "done" })]);
  expect(await text("old.md")).toBe("# Sent long ago\n");
});

test("stopping an upload leaves nothing at the path", async () => {
  const { owner, ask } = await connect();
  const sink = recorder();
  let open: () => void = idle;
  const held = new Promise<void>((resolve) => (open = resolve));
  const picks = staged({ aaaaaaaa: Buffer.alloc(200 * 1024, 1) }, (offset) =>
    offset > 0 ? held : undefined,
  );
  const uploads = new CheckoutUploads(owner, sink, picks.read);
  uploads.handle({
    type: "files.upload",
    id: "halt",
    threadId: scope.threadId,
    folder: "",
    files: [picks.meta("aaaaaaaa", "halted.bin")],
  });
  await until(() =>
    sink.seen.some((each) => (each.items as { sent: number }[] | undefined)?.[0]?.sent),
  );
  uploads.handle({ type: "files.upload.cancel", id: "halt" });
  open();
  await until(() => sink.last("files.upload", "halt")?.phase === "stopped");
  expect(await ask({ op: "read", path: "halted.bin" })).toMatchObject({ kind: "missing" });
});

test("quick open offers recent files with nothing typed, and keeps a typed line", async () => {
  const { ask, memory } = await connect();
  await memory.handle({ type: "files.opened", scope, path: "docs/plan.md" });
  const empty = await ask({ op: "quick", text: "" });
  expect(empty.rows).toEqual([
    expect.objectContaining({ path: "docs/plan.md", name: "plan.md", group: "Opened recently" }),
  ]);
  const typed = await ask({ op: "quick", text: "plan:12" });
  expect(typed).toMatchObject({ query: "plan", line: 12 });
});
