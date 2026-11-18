import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFilesHost } from "./host.ts";
import { FilesProcess } from "./process.ts";
import type { EventPayload, Op, SearchQuery } from "./schemas.ts";
import { restartDelay } from "./supervision.ts";
import {
  fakeFilesHarness,
  fakeFilesHost,
  fakeMessages,
  fakeSpawnCount,
  ManualClock,
  settle,
  stopFakeFiles,
  until,
  type FakeFilesHarness,
} from "./test-support.ts";

const open: FakeFilesHarness[] = [];

function harness(behaviour: Parameters<typeof fakeFilesHarness>[0] = "answer"): FakeFilesHarness {
  const h = fakeFilesHarness(behaviour);
  open.push(h);
  return h;
}

function registered(
  behaviour: Parameters<typeof fakeFilesHarness>[0],
  options: Parameters<typeof fakeFilesHarness>[1],
): FakeFilesHarness {
  const h = fakeFilesHarness(behaviour, options);
  open.push(h);
  return h;
}

afterEach(async () => {
  for (const h of open.splice(0)) await stopFakeFiles(h);
});

function requestOps(h: FakeFilesHarness): string[] {
  return fakeMessages(h).flatMap((message) => (message.type === "request" ? [message.op.op] : []));
}

const query: SearchQuery = {
  pattern: "cache",
  regex: false,
  case: "smart",
  wholeWord: true,
  include: [],
  exclude: [],
  includeIgnored: false,
  maxMatches: 10,
  maxFileBytes: 1024,
};

describe("FilesProcess", () => {
  it("starts ace-files, sends hello and accepts requests after the handshake", async () => {
    const h = harness();
    await h.files.start();
    expect(h.files.state()).toBe("up");
    expect(h.files.version).toBe("0.0.0-test");
    expect(fakeMessages(h)).toContainEqual({ type: "hello", protocol: 1 });
    const root = await h.files.openRoot("/repo");
    expect(root).toBe(1);
    const { reply } = await h.files.request({ op: "stat", root, path: "src/main.ts" });
    expect(reply).toMatchObject({ type: "entry", path: "src/main.ts" });
  });

  it("a read resolves with the bytes of its body frame", async () => {
    const h = harness();
    await h.files.start();
    const root = await h.files.openRoot("/repo");
    const { reply, body } = await h.files.request({
      op: "read",
      root,
      path: "README.md",
      offset: 0,
      length: 16,
    });
    expect(reply.type).toBe("read");
    expect(new TextDecoder().decode(body)).toBe("read:README.md");
  });

  it("request() refuses every op that has a dedicated method", async () => {
    const h = harness();
    await h.files.start();
    const ops: Op[] = [
      { op: "openRoot", path: "/repo" },
      { op: "closeRoot", root: 1 },
      { op: "watch", root: 1 },
      { op: "unwatch", subscription: 1 },
      { op: "search", root: 1, ...query },
    ];
    for (const op of ops)
      await expect(h.files.request(op)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("restarts after 250 ms, then 500 ms, when the process keeps exiting", async () => {
    const h = harness("exit");
    void h.files.start().catch(() => {});
    await until(() => fakeSpawnCount(h) === 1);
    await until(() => h.files.state() === "down");
    await h.clock.advance(249);
    expect(fakeSpawnCount(h)).toBe(1);
    await h.clock.advance(1);
    await until(() => fakeSpawnCount(h) === 2);
    await until(() => h.files.state() === "down");
    await h.clock.advance(499);
    expect(fakeSpawnCount(h)).toBe(2);
    await h.clock.advance(1);
    await until(() => fakeSpawnCount(h) === 3);
  });

  it("backs off from 250 ms doubling to a 10 s cap", () => {
    const delays = Array.from({ length: 8 }, (_, index) => restartDelay(index + 1));
    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  it("resets the backoff after a run stayed up for a minute", async () => {
    const h = harness();
    await h.files.start();
    await h.clock.advance(60_000);
    h.host.children.at(-1)?.kill();
    await until(() => h.files.state() === "down");
    await h.clock.advance(249);
    expect(fakeSpawnCount(h)).toBe(1);
    await h.clock.advance(1);
    await until(() => fakeSpawnCount(h) === 2);
    await until(() => h.files.state() === "up");
  });

  it("fails requests at once with FILES_RESTARTING while the process is down", async () => {
    const h = harness("exit");
    void h.files.start().catch(() => {});
    await until(() => h.files.state() === "down");
    const failure: unknown = await h.files
      .request({ op: "stat", root: 1, path: "a" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "FILES_RESTARTING", retryable: true });
  });

  it("fails a request after its timeout and cancels it in ace-files", async () => {
    const h = harness("hang");
    await h.files.start();
    const pending = h.files.openRoot("/repo");
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await h.clock.advance(29_999);
    await settle();
    expect(settled).toBe(false);
    await h.clock.advance(1);
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await until(() => fakeMessages(h).some((message) => message.type === "cancel"));
  });

  it("aborting a request sends cancel", async () => {
    const h = harness("hold-requests");
    await h.files.start();
    const root = await h.files.openRoot("/repo");
    const controller = new AbortController();
    const pending = h.files.request({ op: "stat", root, path: "a" }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await until(() => fakeMessages(h).some((message) => message.type === "cancel"));
  });

  it("re-opens roots and watches after a restart, keeping their numbers", async () => {
    const h = harness();
    await h.files.start();
    const root = await h.files.openRoot("/repo");
    const batches: EventPayload[] = [];
    const watch = await h.files.watch(root, (payload) => batches.push(payload));
    await until(() => batches.length === 1);
    expect(batches[0]).toMatchObject({ type: "changes" });
    h.host.children.at(-1)?.kill();
    await until(() => h.files.state() === "down");
    await h.clock.advance(250);
    await until(() => fakeSpawnCount(h) === 2 && h.files.state() === "up");
    expect(requestOps(h).filter((op) => op === "openRoot")).toHaveLength(2);
    expect(requestOps(h).filter((op) => op === "watch")).toHaveLength(2);
    // The restarted fake only knows the root number it handed out this generation, so this
    // answers only if the supervisor translated the caller's root 1 to it.
    const { reply } = await h.files.request({ op: "stat", root, path: "src/main.ts" });
    expect(reply.type).toBe("entry");
    await until(() => batches.length === 2);
    await watch.dispose();
  });

  it("keeps serving other roots when one cannot be re-opened after a restart", async () => {
    const h = registered("answer", {
      env: (dir) => ({
        FAKE_FILES_MISSING_ROOT: "/repo/gone",
        FAKE_FILES_VANISH_FILE: join(dir, "vanished"),
      }),
    });
    await h.files.start();
    const good = await h.files.openRoot("/repo/good");
    const gone = await h.files.openRoot("/repo/gone");
    const warnings: EventPayload[] = [];
    await h.files.watch(gone, (payload) => {
      if (payload.type === "warning") warnings.push(payload);
    });
    writeFileSync(join(h.dir, "vanished"), "");
    h.host.children.at(-1)?.kill();
    await until(() => h.files.state() === "down");
    await h.clock.advance(250);
    await until(() => fakeSpawnCount(h) === 2 && h.files.state() === "up");
    const { reply } = await h.files.request({ op: "stat", root: good, path: "src/main.ts" });
    expect(reply.type).toBe("entry");
    await expect(
      h.files.request({ op: "stat", root: gone, path: "src/main.ts" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(warnings).toHaveLength(1);
  });

  it("closes a watch that was disposed while its re-open was in flight", async () => {
    const h = registered("answer", { env: () => ({ FAKE_FILES_SLOW_WATCH_MS: "100" }) });
    await h.files.start();
    const root = await h.files.openRoot("/repo");
    const watch = await h.files.watch(root, () => {});
    h.host.children.at(-1)?.kill();
    await until(() => h.files.state() === "down");
    await h.clock.advance(250);
    await until(() => fakeSpawnCount(h) === 2);
    await until(
      () =>
        fakeMessages(h).filter((message) => message.type === "request" && message.op.op === "watch")
          .length === 2,
    );
    await watch.dispose();
    await until(() => h.files.state() === "up");
    await until(() =>
      fakeMessages(h).some((message) => message.type === "request" && message.op.op === "unwatch"),
    );
  });

  it("kills a process that sends an oversize frame and restarts it", async () => {
    const h = harness("oversize");
    void h.files.start().catch(() => {});
    await until(() => fakeSpawnCount(h) === 1);
    await until(() => h.files.state() === "down");
    await h.clock.advance(250);
    await until(() => fakeSpawnCount(h) === 2);
  });

  it("start() rejects when the binary is missing", async () => {
    const files = new FilesProcess({
      binary: "/nonexistent/ace-files",
      host: nodeFilesHost({}, () => ({ command: "/nonexistent/ace-files", args: [] })),
      clock: new ManualClock(),
      log: () => {},
    });
    await expect(files.start()).rejects.toMatchObject({ code: "FILES_RESTARTING" });
    files.dispose();
  });

  it("start() rejects when the process exits during the handshake", async () => {
    const h = harness("exit");
    await expect(h.files.start()).rejects.toMatchObject({ code: "FILES_RESTARTING" });
  });

  it("kills a silent process after 10 s and settles start()", async () => {
    const h = harness("silent");
    const started = h.files.start();
    let settled = false;
    void started.catch(() => {
      settled = true;
    });
    await until(() => fakeSpawnCount(h) === 1);
    await h.clock.advance(9_999);
    await settle();
    expect(settled).toBe(false);
    await h.clock.advance(1);
    await expect(started).rejects.toMatchObject({ code: "FILES_RESTARTING" });
  });

  it("dispose settles a start() waiting through the restart backoff", async () => {
    const h = harness("exit");
    await expect(h.files.start()).rejects.toMatchObject({ code: "FILES_RESTARTING" });
    const waiting = h.files.start();
    h.files.dispose();
    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("delivers a response the process wrote just before it exited", async () => {
    const h = harness("answer-exit");
    await h.files.start();
    const root = await h.files.openRoot("/repo");
    const { reply } = await h.files.request({ op: "stat", root, path: "src/main.ts" });
    expect(reply).toMatchObject({ type: "entry", path: "src/main.ts" });
  });

  it("fails the request whose reply the decoder cannot read", async () => {
    const h = harness("corrupt-reply");
    await h.files.start();
    await expect(h.files.openRoot("/repo")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("aborting a running search unwatches it", async () => {
    const h = harness("search-hang");
    await h.files.start();
    const root = await h.files.openRoot("/repo");
    const controller = new AbortController();
    const search = h.files.search(root, query, {
      onMatches: () => {},
      signal: controller.signal,
    });
    await until(() =>
      fakeMessages(h).some((message) => message.type === "request" && message.op.op === "search"),
    );
    controller.abort();
    await expect(search).rejects.toMatchObject({ code: "CANCELLED" });
    await until(() =>
      fakeMessages(h).some((message) => message.type === "request" && message.op.op === "unwatch"),
    );
  });

  it("aborting a search whose reply has not arrived sends cancel", async () => {
    const h = harness("search-hold");
    await h.files.start();
    const root = await h.files.openRoot("/repo");
    const controller = new AbortController();
    const search = h.files.search(root, query, {
      onMatches: () => {},
      signal: controller.signal,
    });
    await until(() =>
      fakeMessages(h).some((message) => message.type === "request" && message.op.op === "search"),
    );
    controller.abort();
    await expect(search).rejects.toMatchObject({ code: "CANCELLED" });
    await until(() => fakeMessages(h).some((message) => message.type === "cancel"));
  });

  it("times out a read whose body frame never arrives", async () => {
    const h = registered("read-no-body", { timeoutMs: 1_000 });
    await h.files.start();
    const root = await h.files.openRoot("/repo");
    const pending = h.files.request({
      op: "read",
      root,
      path: "README.md",
      offset: 0,
      length: 8,
    });
    await h.clock.advance(1_000);
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await until(() => fakeMessages(h).some((message) => message.type === "cancel"));
  });

  it("queues frames under stdin backpressure and refuses body writes with BUSY", async () => {
    const { host, child } = fakeFilesHost();
    const files = new FilesProcess({
      binary: "/fake/ace-files",
      host,
      clock: new ManualClock(),
      stdinQueueLimit: 0,
      log: () => {},
    });
    child.stdin.blocked = true;
    const started = files.start();
    child.send({ type: "hello", protocol: 1, version: "test" });
    await started;
    expect(child.stdin.writes).toHaveLength(1);
    const rootPromise = files.openRoot("/repo");
    child.send({ type: "response", id: 1, result: { type: "root", root: 7 } });
    const root = await rootPromise;
    await expect(
      files.request({ op: "write", root, path: "README.md" }, { body: Uint8Array.of(1) }),
    ).rejects.toMatchObject({ code: "BUSY", retryable: true });
    child.stdin.drain();
    await until(() => child.stdin.writes.length >= 2);
    files.dispose();
  });
});
