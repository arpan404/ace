import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId, ThreadId, type ServerMessage } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import {
  CheckoutContentSearch,
  NativeContentSearchAction,
  type SearchOwner,
} from "./checkout-content-search.ts";
import type { Timers } from "./kept-read.ts";
import { until } from "./test-host.ts";

/*
 * Search in file contents for the Files screen: the `files.contents` patch the phone draws, from
 * the real SDK against an in-process fake daemon, and with a held-open fake socket for the
 * cancel and typing-pause rules.
 */

type Patch = Record<string, unknown>;
const thread = "ios-search";

function patches() {
  const latest = new Map<string, () => Record<string, unknown> | undefined>();
  return {
    sink: {
      put: (key: string, read: () => Record<string, unknown> | undefined) => latest.set(key, read),
    },
    read: (threadId = thread): Patch | undefined => latest.get(`files.contents:${threadId}`)?.(),
  };
}

/** Timers the test runs by hand. */
function clock() {
  const waiting = new Set<{ delay: number; callback: () => void }>();
  const timers: Timers = {
    set(delay, callback) {
      const timer = { delay, callback };
      waiting.add(timer);
      return () => waiting.delete(timer);
    },
  };
  return {
    timers,
    pending: () => waiting.size,
    run() {
      const due = [...waiting];
      waiting.clear();
      for (const timer of due) timer.callback();
    },
  };
}

const search = (
  pattern: string,
  extra: Partial<{ now: boolean; threadId: string; regex: boolean }> = {},
) =>
  NativeContentSearchAction.parse({
    type: "files.contents.search",
    threadId: extra.threadId ?? thread,
    query: { pattern, matchCase: false, wholeWord: false, regex: extra.regex ?? false },
    now: extra.now ?? false,
  });

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connected(fake: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-search-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(fake),
    credential: async () => ({ token: "t" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
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
  return owner;
}

function daemon(): FakeDaemon {
  const fake = new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "t" });
  fake.createThread({ id: thread, workspaceId: "ace", title: "Search", provider: "claude" });
  const put = (path: string, text: string) =>
    fake.checkouts.seedBytes(thread, path, new TextEncoder().encode(text));
  put("src/relay/outbox.ts", "const queue = [];\n// TODO flush the queue\nqueue.push(todo);\n");
  put("docs/plain.md", "Nothing to do here.\n");
  put("docs/notes.md", "todo: write the guide\n");
  return fake;
}

test("matches come back grouped by file, counted, with each match marked in its line", async () => {
  const owner = await connected(daemon());
  const out = patches();
  const contents = new CheckoutContentSearch(owner, out.sink, clock().timers, () =>
    crypto.randomUUID(),
  );
  contents.handle(search("todo", { now: true }));
  const done = await until(() => (out.read()?.status === "done" ? out.read() : undefined));
  expect(done).toMatchObject({
    status: "done",
    tally: "3 results in 2 files",
    note: null,
    error: null,
  });
  expect(done.files).toEqual([
    {
      path: "docs/notes.md",
      name: "notes.md",
      folder: "docs",
      count: 1,
      lines: [
        {
          key: "docs/notes.md:1",
          line: 1,
          column: 0,
          length: 4,
          parts: [
            { text: "todo", match: true },
            { text: ": write the guide", match: false },
          ],
        },
      ],
    },
    expect.objectContaining({
      path: "src/relay/outbox.ts",
      name: "outbox.ts",
      folder: "src/relay",
      count: 2,
      lines: [
        expect.objectContaining({ line: 2, column: 3, length: 4 }),
        expect.objectContaining({ line: 3, column: 11, length: 4 }),
      ],
    }),
  ]);
});

test("a search that reaches the match limit says the list was cut", async () => {
  const fake = daemon();
  const many = Array.from({ length: 2100 }, (_, line) => `hit ${line}`).join("\n");
  fake.checkouts.seedBytes(thread, "big.txt", new TextEncoder().encode(many));
  const out = patches();
  const contents = new CheckoutContentSearch(await connected(fake), out.sink, clock().timers, () =>
    crypto.randomUUID(),
  );
  contents.handle(search("hit", { now: true }));
  const done = await until(() => (out.read()?.status === "done" ? out.read() : undefined));
  expect(done).toMatchObject({
    tally: "2,000 results in 1 file",
    note: "Showing the first 2,000 results. Narrow the search to see the rest.",
  });
});

test("a pattern the daemon refuses says why instead of showing no results", async () => {
  const out = patches();
  const contents = new CheckoutContentSearch(
    await connected(daemon()),
    out.sink,
    clock().timers,
    () => crypto.randomUUID(),
  );
  contents.handle(search("(unclosed", { now: true, regex: true }));
  const failed = await until(() => (out.read()?.status === "failed" ? out.read() : undefined));
  expect(failed.error).toBe("That pattern or file filter isn't valid.");
  expect(failed.files).toEqual([]);
});

/** A socket whose searches stay open until the test ends them. */
function heldSocket() {
  const listeners = new Set<(message: ServerMessage) => void>();
  const requests: { threadId: string; pattern: string; requestId: string; signal: AbortSignal }[] =
    [];
  const owner = {
    onMessage(listener: (message: ServerMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(
      input: { threadId: string; operation: { pattern: string } },
      options: { requestId: string; signal: AbortSignal },
    ) {
      requests.push({
        threadId: input.threadId,
        pattern: input.operation.pattern,
        requestId: options.requestId,
        signal: options.signal,
      });
      return new Promise((_, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      );
    },
  } as unknown as SearchOwner;
  const push = (searchId: string, path: string) => {
    for (const listener of listeners)
      listener({
        type: "files.search.matches",
        searchId,
        files: [{ path, lines: [{ line: 1, column: 0, preview: "hit", ranges: [[0, 3]] }] }],
      });
  };
  return { owner, requests, push };
}

test("a newer query stops the running search at once and its late matches never show", () => {
  const socket = heldSocket();
  const time = clock();
  const out = patches();
  let ids = 0;
  const contents = new CheckoutContentSearch(socket.owner, out.sink, time.timers, () => `${++ids}`);
  contents.handle(search("old", { now: true }));
  const first = socket.requests[0];
  if (!first) throw new Error("no search started");
  socket.push(first.requestId, "old.ts");
  socket.push(first.requestId, "old.ts");
  expect(out.read()).toMatchObject({ status: "searching", tally: "2 results in 1 file" });

  contents.handle(search("olde"));
  expect(first.signal.aborted).toBe(true);
  expect(out.read()).toMatchObject({ status: "searching", tally: null, files: [] });
  socket.push(first.requestId, "late.ts");
  expect(out.read()).toMatchObject({ files: [], query: { pattern: "olde" } });

  // The new search waits for typing to pause.
  expect(socket.requests).toHaveLength(1);
  time.run();
  expect(socket.requests.map((request) => request.pattern)).toEqual(["old", "olde"]);
});

test("each keystroke restarts the pause, so only the last query is searched", () => {
  const socket = heldSocket();
  const time = clock();
  const contents = new CheckoutContentSearch(socket.owner, patches().sink, time.timers, () => "id");
  contents.handle(search("t"));
  contents.handle(search("to"));
  contents.handle(search("tod"));
  expect(time.pending()).toBe(1);
  time.run();
  expect(socket.requests.map((request) => request.pattern)).toEqual(["tod"]);
});

test("clearing the field stops the search and empties the list", () => {
  const socket = heldSocket();
  const out = patches();
  const contents = new CheckoutContentSearch(socket.owner, out.sink, clock().timers, () => "id");
  contents.handle(search("todo", { now: true }));
  const running = socket.requests[0];
  if (!running) throw new Error("no search started");
  socket.push(running.requestId, "a.ts");
  contents.handle(
    NativeContentSearchAction.parse({ type: "files.contents.stop", threadId: thread }),
  );
  expect(running.signal.aborted).toBe(true);
  expect(out.read()).toMatchObject({
    status: "idle",
    files: [],
    tally: null,
    query: { pattern: "" },
  });
});

test("searching a fourth thread stops the oldest thread's search", () => {
  const socket = heldSocket();
  const contents = new CheckoutContentSearch(
    socket.owner,
    patches().sink,
    clock().timers,
    () => `${socket.requests.length}`,
  );
  for (const id of ["a", "b", "c", "d"])
    contents.handle(search("todo", { now: true, threadId: ThreadId.parse(id) }));
  expect(socket.requests.map((request) => [request.threadId, request.signal.aborted])).toEqual([
    ["a", true],
    ["b", false],
    ["c", false],
    ["d", false],
  ]);
});
