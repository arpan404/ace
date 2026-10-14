import { expect, onTestFinished, test } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSupervised } from "@ace/provider-kit/process";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { openCodexSession } from "./session.ts";
import { createCodexAdapter, CodexHostPool } from "./index.ts";
import { replayHarness } from "./replay.test-helper.ts";
import { obj } from "./native.ts";

async function harness(shared = true) {
  const directory = await mkdtemp(join(tmpdir(), "ace-codex-drops-"));
  const binary = join(directory, "codex.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/oversized-cli.ts", import.meta.url).href)};\n`,
  );
  await chmod(binary, 0o755);
  const pool = new CodexHostPool();
  const openSession: typeof openCodexSession = (ctx, options) =>
    shared ? createCodexAdapter(options).openSession(ctx) : openCodexSession(ctx, options);
  const sessions: Awaited<ReturnType<typeof openCodexSession>>[] = [];
  let now = 0;
  const scheduled = new Map<() => void, number>();
  onTestFinished(async () => {
    for (const session of sessions) await session.close("shutdown");
    await pool.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function open(resume?: string) {
    const frames: Frame[] = [];
    const replay = replayHarness();
    const exits: unknown[] = [];
    const waiters = new Set<{ match(frame: Frame): boolean; resolve(frame: Frame): void }>();
    const opening = openSession(
      {
        threadId: ThreadId.parse("fixture"),
        cwd: directory,
        signal: new AbortController().signal,
        ...(resume ? { resume: { nativeSessionId: resume } } : {}),
        onFrame(frame) {
          frames.push(frame);
          replay.feed(frame);
          for (const waiter of waiters)
            if (waiter.match(frame)) {
              waiters.delete(waiter);
              waiter.resolve(frame);
            }
        },
        onExit(exit) {
          exits.push(exit);
        },
      },
      {
        ...(shared ? { hosts: pool } : {}),
        cli: {
          installed: true,
          path: binary,
          version: "0.159.1",
          auth: "logged_in",
          loginHint: "",
        },
        runtime: {
          stopGraceMs: 0,
          homeDir: () => directory,
          now: () => now,
          spawn: (options) => spawnSupervised({ ...options, maxLineBytes: 2048 }),
          schedule(callback, delay) {
            scheduled.set(callback, delay);
            return () => {
              scheduled.delete(callback);
            };
          },
        },
      },
    );
    const session = await opening;
    sessions.push(session);
    return {
      session,
      frames,
      replay,
      exits,
      wait(match: (frame: Frame) => boolean) {
        const previous = frames.find(match);
        return previous
          ? Promise.resolve(previous)
          : new Promise<Frame>((resolve) => waiters.add({ match, resolve }));
      },
    };
  }
  return {
    open,
    runTimers() {
      for (const [callback, delay] of Array.from(scheduled)) {
        if (delay !== 2000) continue;
        scheduled.delete(callback);
        now += delay;
        callback();
      }
    },
  };
}
const note = (event: string) => (frame: Frame) => obj(frame.data)["event"] === event;
const completed = (frame: Frame) => obj(frame.data)["method"] === "turn/completed";
const send = (h: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>["open"]>>, text: string) =>
  h.session.send([{ type: "text", text }], "steer");
const pid = (frames: Frame[]) =>
  frames.map((f) => obj(obj(f.data)["result"])["pid"]).find((id) => typeof id === "number");

test.each(["drop-completion", "drop-item", "unattributed"])(
  "a dropped live line recovers its thread while its neighbour keeps working (%s)",
  async (mode) => {
    const h = await harness();
    const a = await h.open();
    const b = await h.open();
    expect(pid(a.frames)).toBeDefined();
    expect(pid(a.frames)).toBe(pid(b.frames));
    await send(b, "hold");
    await b.wait((f) => obj(f.data)["method"] === "item/started");
    await send(a, mode);
    const dropped = await a.wait(note("output-line-dropped"));
    expect(obj(dropped.data)["bytes"]).toBeGreaterThan(2048);
    expect(a.replay.state.status.state).not.toBe("done");
    expect(b.replay.state.status.state).not.toBe("done");
    h.runTimers();
    await a.wait(
      (f) => note("discovery-finished")(f) && obj(f.data)["task"] === "codex:output-recovery",
    );
    await b.wait(
      (f) => note("discovery-finished")(f) && obj(f.data)["task"] === "codex:output-recovery",
    );
    expect(a.replay.state.status.state).toBe("done");
    expect(b.replay.state.status.state).not.toBe("done");
    await b.session.interrupt({ agent: "root", cascade: false });
    await b.wait(completed);
    await send(b, "next");
    await b.wait((f) => obj(f.data)["method"] === "item/completed");
    expect(a.exits).toEqual([]);
    expect(b.exits).toEqual([]);
    const c = await h.open();
    expect(pid(c.frames)).toBe(pid(a.frames));
  },
);

test.each(["oversized", "partial-reply"])(
  "a dropped reply rejects only its pending request and keeps both tenants usable (%s)",
  async (mode) => {
    const h = await harness();
    const a = await h.open();
    const b = await h.open();
    const neighbour = b.session.configure?.({
      provider: "codex",
      model: "hold-reply",
      options: {},
    });
    const neighbourResult = neighbour?.then(
      () => "resolved",
      () => "rejected",
    );
    await b.wait((f) => f.dir === "send" && obj(obj(f.data)["params"])["model"] === "hold-reply");
    const failed = a.session.configure?.({ provider: "codex", model: mode, options: {} });
    await expect(failed).rejects.toThrow("reply dropped");
    await a.wait(note("output-line-dropped"));
    if (mode === "partial-reply")
      await a.session.configure?.({ provider: "codex", model: "partial-flush", options: {} });
    expect(a.frames.some(note("discovery-start"))).toBe(false);
    expect(b.frames.some(note("discovery-start"))).toBe(false);
    await a.session.configure?.({ provider: "codex", model: "release-reply", options: {} });
    await expect(neighbourResult).resolves.toBe("resolved");
    await Promise.all([send(a, "next"), send(b, "next")]);
    await Promise.all([a.wait(completed), b.wait(completed)]);
    expect(a.exits).toEqual([]);
    expect(b.exits).toEqual([]);
  },
);

test("oversized history pages retry smaller and omit only turns whose summary is also oversized", async () => {
  const h = await harness();
  const neighbour = await h.open();
  const a = await h.open("history");
  const items = Object.values(a.replay.state.items);
  const messages = items.filter((item) => item.type === "message");
  expect(messages.length).toBe(6); // Four full turns, one summary, and the turn after the omitted one.
  const requests = a.frames
    .filter((f) => f.dir === "send" && obj(f.data)["method"] === "thread/turns/list")
    .map((f) => obj(obj(f.data)["params"]));
  expect(requests.slice(0, 2).map((p) => p["limit"])).toEqual([4, 1]);
  expect(requests.some((p) => p["itemsView"] === "summary")).toBe(true);
  expect(requests.some((p) => p["itemsView"] === "notLoaded")).toBe(true);
  const omitted = a.frames.filter(note("thread-history-omitted")).map((f) => obj(f.data)["turnId"]);
  expect(omitted).toEqual(["huge", "summary-huge"]);
  await send(neighbour, "next");
  await neighbour.wait(completed);
  expect(pid(a.frames)).toBe(pid(neighbour.frames));
});

test("a dedicated Codex host still stops on an oversized stdout line", async () => {
  const h = await harness(false);
  const a = await h.open();
  await expect(
    a.session.configure?.({ provider: "codex", model: "oversized", options: {} }),
  ).rejects.toThrow("process exited");
  const exit = await a.wait(note("codex-session-exit"));
  expect(obj(exit.data)["reason"]).toBe("output-limit");
  expect(a.exits).toHaveLength(1);
  expect(a.frames.some(note("output-line-dropped"))).toBe(false);
});

test("a second drop fences an idle snapshot already in flight and keeps the new turn working", async () => {
  const h = await harness();
  const a = await h.open();
  const b = await h.open();
  await b.session.configure?.({ provider: "codex", model: "hold-history", options: {} });
  await send(a, "drop-completion");
  await b.wait((f) => obj(f.data)["method"] === "test/history-held");
  await b.session.configure?.({ provider: "codex", model: "dropped-start", options: {} });
  const stale = await b.wait(
    (f) => note("thread-discovered")(f) && obj(obj(f.data)["revision"])["uncertain"] === true,
  );
  expect(obj(obj(stale.data)["thread"])["status"]).toEqual({ type: "idle" });
  expect(b.replay.state.status.state).not.toBe("done");
  h.runTimers();
  await b.wait(
    (f) => note("discovery-finished")(f) && obj(f.data)["task"] === "codex:output-recovery",
  );
  expect(b.replay.state.status.state).toBe("working");
  await b.session.interrupt({ agent: "root", cascade: false });
  await b.wait(completed);
});

test.each(["drop-background", "drop-unseen-background"])(
  "omitted history keeps a background shell working until Codex confirms it finished (%s)",
  async (mode) => {
    const h = await harness();
    const a = await h.open();
    await send(a, mode);
    await a.wait(
      (f) => note("discovery-finished")(f) && obj(f.data)["task"] === "codex:output-recovery",
    );
    expect(a.frames.some(note("thread-history-omitted"))).toBe(true);
    expect(a.replay.state.status.state).not.toBe("done");
    await a.session.configure?.({ provider: "codex", model: "finish-shell", options: {} });
    expect(a.replay.state.status.state).toBe("done");
  },
);

test("fresh idle reads settle repeated inferred work after dropped completions with no stored turn", async () => {
  const h = await harness();
  const a = await h.open();
  for (let round = 0; round < 2; round++) {
    const before = a.frames.at(-1)?.seq ?? 0;
    await a.session.configure?.({ provider: "codex", model: "ephemeral-start", options: {} });
    await a.wait(
      (f) =>
        f.seq > before &&
        note("thread-discovered")(f) &&
        obj(obj(obj(f.data)["thread"])["status"])["type"] === "active",
    );
    expect(a.replay.state.status.state).toBe("working");
    const barrier = a.frames.at(-1)?.seq ?? 0;
    await a.session.configure?.({ provider: "codex", model: "ephemeral-end", options: {} });
    await a.wait(
      (f) =>
        f.seq > barrier &&
        note("discovery-finished")(f) &&
        obj(f.data)["task"] === "codex:output-recovery",
    );
    expect(a.replay.state.status.state).toBe("done");
  }
});

test("closing a tenant with unrecovered controls stops its unobserved work on the shared host", async () => {
  const h = await harness();
  const a = await h.open();
  const b = await h.open();
  await send(b, "hold");
  await b.wait((f) => obj(f.data)["method"] === "item/started");
  await a.session.configure?.({ provider: "codex", model: "ephemeral-start", options: {} });
  await a.wait(
    (f) => note("thread-discovered")(f) && obj(obj(f.data)["revision"])["uncertain"] === true,
  );
  expect(a.replay.state.status.state).not.toBe("done");
  await a.session.close("user");
  await b.wait(note("codex-session-exit"));
  expect(b.exits).toEqual([expect.objectContaining({ deliberate: false })]);
  const c = await h.open();
  expect(pid(c.frames)).not.toBe(pid(a.frames));
});

test("an unfinished oversized notification makes every tenant uncertain before its newline", async () => {
  const h = await harness();
  const a = await h.open();
  const b = await h.open();
  await send(b, "next");
  await b.wait(completed);
  await b.wait(note("discovery-finished"));
  expect(b.replay.state.status.state).toBe("done");
  await a.session.configure?.({ provider: "codex", model: "partial-start", options: {} });
  await a.wait((f) => note("output-line-dropped")(f) && obj(f.data)["phase"] === "start");
  expect(a.replay.state.status.state).not.toBe("done");
  expect(b.replay.state.status.state).not.toBe("done");
  await a.session.configure?.({ provider: "codex", model: "partial-flush", options: {} });
  await b.wait(
    (f) => note("discovery-finished")(f) && obj(f.data)["task"] === "codex:output-recovery",
  );
  expect(b.replay.state.status.state).toBe("done");
  expect(a.replay.state.status.state).not.toBe("done");
  await a.session.configure?.({ provider: "codex", model: "ephemeral-end", options: {} });
  await a.wait(
    (f) => note("discovery-finished")(f) && obj(f.data)["task"] === "codex:output-recovery",
  );
  expect(a.replay.state.status.state).toBe("done");
  expect(a.exits).toEqual([]);
  expect(b.exits).toEqual([]);
});
