import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { CodexHostPool } from "./host-pool.ts";
import { obj, str } from "./native.ts";
import { openCodexSession } from "./session.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fakeCodex() {
  const directory = await mkdtemp(join(tmpdir(), "ace-codex-shared-"));
  const binary = join(directory, "codex.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/shared-cli.ts", import.meta.url).href)};\n`,
  );
  await chmod(binary, 0o755);
  const pool = new CodexHostPool();
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  cleanups.push(() => pool.close());
  return { directory, binary, pool };
}

async function open(
  fake: Awaited<ReturnType<typeof fakeCodex>>,
  name: string,
  shared = true,
  controller = new AbortController(),
) {
  const cwd = join(fake.directory, name);
  await mkdir(cwd, { recursive: true });
  const frames: Frame[] = [];
  const exit = Promise.withResolvers<{ deliberate: boolean; message?: string }>();
  const waiters = new Set<{ match(frame: Frame): boolean; resolve(frame: Frame): void }>();
  const opening = openCodexSession(
    {
      threadId: ThreadId.parse(name),
      cwd,
      signal: controller.signal,
      onFrame(frame) {
        frames.push(frame);
        for (const waiter of waiters)
          if (waiter.match(frame)) {
            waiters.delete(waiter);
            waiter.resolve(frame);
          }
      },
      onExit: (result) => exit.resolve(result),
    },
    {
      cli: {
        installed: true,
        path: fake.binary,
        version: "0.159.1",
        auth: "logged_in",
        loginHint: "",
      },
      runtime: { stopGraceMs: 0, homeDir: () => fake.directory },
      ...(shared ? { hosts: fake.pool } : {}),
    },
  );
  return {
    opening,
    frames,
    exited: exit.promise,
    wait(match: (data: Record<string, unknown>) => boolean): Promise<Frame> {
      const seen = frames.find((frame) => match(obj(frame.data)));
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) =>
        waiters.add({ match: (frame) => match(obj(frame.data)), resolve }),
      );
    },
  };
}

async function opened(
  fake: Awaited<ReturnType<typeof fakeCodex>>,
  name: string,
  controller = new AbortController(),
) {
  const handle = await open(fake, name, true, controller);
  const session = await handle.opening;
  cleanups.push(() => session.close("shutdown"));
  return { ...handle, session };
}

const pidOf = (frames: Frame[]) =>
  frames
    .map((frame) => obj(obj(frame.data)["result"])["pid"])
    .find((pid): pid is number => typeof pid === "number");
const threadsIn = (frames: Frame[]) =>
  new Set(
    frames
      .filter((frame) => frame.dir === "recv")
      .map((frame) => str(obj(obj(frame.data)["params"])["threadId"]))
      .filter(Boolean),
  );
const completed = (thread: string) => (data: Record<string, unknown>) =>
  data["method"] === "turn/completed" && obj(data["params"])["threadId"] === thread;

test("threads on one account share an app-server and see only their own events", async () => {
  const fake = await fakeCodex();
  const a = await opened(fake, "a");
  const b = await opened(fake, "b");
  expect(pidOf(a.frames)).toBeDefined();
  expect(pidOf(b.frames)).toBe(pidOf(a.frames));

  await a.session.send([{ type: "text", text: "from a" }], "steer");
  await b.session.send([{ type: "text", text: "from b" }], "steer");
  await a.wait(completed(a.session.nativeSessionId));
  await b.wait(completed(b.session.nativeSessionId));

  expect(threadsIn(a.frames)).toEqual(new Set([a.session.nativeSessionId]));
  expect(threadsIn(b.frames)).toEqual(new Set([b.session.nativeSessionId]));
});

test("checking loaded threads skips the threads other sessions own", async () => {
  const fake = await fakeCodex();
  const a = await opened(fake, "a");
  const b = await opened(fake, "b");
  await a.session.send([{ type: "text", text: "from a" }], "steer");
  await a.wait(
    (data) =>
      obj(data["result"])["data"] !== undefined && Array.isArray(obj(data["result"])["data"]),
  );
  await a.wait((data) => data["event"] === "discovery-finished");
  const reads = a.frames
    .map((frame) => obj(frame.data))
    .filter((data) => data["method"] === "thread/read")
    .map((data) => obj(data["params"])["threadId"]);
  expect(reads).not.toContain(b.session.nativeSessionId);
});

test("closing one idle thread leaves its neighbour working on the same process", async () => {
  const fake = await fakeCodex();
  const a = await opened(fake, "a");
  const b = await opened(fake, "b");
  await a.session.close("idle");
  expect(await a.exited).toMatchObject({ deliberate: true });

  await b.session.send([{ type: "text", text: "still here" }], "steer");
  const done = await b.wait(completed(b.session.nativeSessionId));
  expect(done).toBeDefined();
  const reopened = await opened(fake, "c");
  expect(pidOf(reopened.frames)).toBe(pidOf(b.frames));
});

test("a child that speaks before its parent reveals it reaches only the parent's session", async () => {
  const fake = await fakeCodex();
  const a = await opened(fake, "a");
  const b = await opened(fake, "b");
  const child = `${a.session.nativeSessionId}-child`;
  await a.session.send([{ type: "text", text: "spawn-child" }], "steer");
  await a.wait(completed(child));
  await a.wait(completed(a.session.nativeSessionId));

  expect(threadsIn(a.frames)).toContain(child);
  expect(threadsIn(b.frames).has(child)).toBe(false);
});

test("a request that names only its turn reaches the session that owns the turn", async () => {
  const fake = await fakeCodex();
  const a = await opened(fake, "a");
  const b = await opened(fake, "b");
  await b.session.send([{ type: "text", text: "ask-by-turn" }], "steer");
  const asked = (data: Record<string, unknown>) =>
    data["method"] === "mcpServer/elicitation/request";
  await b.wait(asked);
  expect(a.frames.some((frame) => asked(obj(frame.data)))).toBe(false);
});

test("stopping a busy thread interrupts its own turn and not its neighbour's", async () => {
  const fake = await fakeCodex();
  const a = await opened(fake, "a");
  const b = await opened(fake, "b");
  await a.session.send([{ type: "text", text: "hold" }], "steer");
  await b.session.send([{ type: "text", text: "hold" }], "steer");
  await a.wait((data) => data["method"] === "item/completed");
  await b.wait((data) => data["method"] === "item/completed");

  await a.session.close("user");
  const interrupted = a.frames.find((frame) =>
    completed(a.session.nativeSessionId)(obj(frame.data)),
  );
  expect(obj(obj(obj(interrupted?.data)["params"])["turn"])["status"]).toBe("interrupted");
  expect(b.frames.some((frame) => completed(b.session.nativeSessionId)(obj(frame.data)))).toBe(
    false,
  );

  await b.session.interrupt({ agent: "root", cascade: false });
  const stopped = await b.wait(completed(b.session.nativeSessionId));
  expect(obj(obj(obj(stopped.data)["params"])["turn"])["status"]).toBe("interrupted");
});

test("cancelling a busy thread's session interrupts its tree and keeps its neighbour's process", async () => {
  const fake = await fakeCodex();
  const controller = new AbortController();
  const a = await opened(fake, "a", controller);
  const b = await opened(fake, "b");
  await a.session.send([{ type: "text", text: "hold" }], "steer");
  await a.wait((data) => data["method"] === "item/completed");

  controller.abort(new Error("Thread deleted"));
  expect(await a.exited).toMatchObject({ deliberate: true });
  const interrupted = a.frames.find((frame) =>
    completed(a.session.nativeSessionId)(obj(frame.data)),
  );
  expect(obj(obj(obj(interrupted?.data)["params"])["turn"])["status"]).toBe("interrupted");

  await b.session.send([{ type: "text", text: "still running" }], "steer");
  await b.wait(completed(b.session.nativeSessionId));
  const c = await opened(fake, "c");
  expect(pidOf(c.frames)).toBe(pidOf(a.frames));
});

test("a crashed app-server ends every session on it and the next open starts a new one", async () => {
  const fake = await fakeCodex();
  const a = await opened(fake, "a");
  const b = await opened(fake, "b");
  const before = pidOf(a.frames);
  await a.session.send([{ type: "text", text: "crash" }], "steer").catch(() => {});

  expect(await a.exited).toMatchObject({ deliberate: false });
  expect(await b.exited).toMatchObject({ deliberate: false });
  const c = await opened(fake, "c");
  expect(pidOf(c.frames)).toBeDefined();
  expect(pidOf(c.frames)).not.toBe(before);
});

test.each([true, false])(
  "cancelling while Codex is still opening reports the cancellation (shared %s)",
  async (shared) => {
    const fake = await fakeCodex();
    const controller = new AbortController();
    const handle = await open(fake, "slow", shared, controller);
    await handle.wait((data) => data["method"] === "thread/start");
    controller.abort(new Error("Opening cancelled by the user"));
    await expect(handle.opening).rejects.toThrow("Opening cancelled by the user");
  },
);
