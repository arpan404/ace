import { afterEach, describe, expect, it } from "vitest";
import type { EventPayload } from "./schemas.ts";
import { restartDelay } from "./supervision.ts";
import {
  fakeFilesHarness,
  fakeMessages,
  fakeSpawnCount,
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

afterEach(async () => {
  for (const h of open.splice(0)) await stopFakeFiles(h);
});

function requestOps(h: FakeFilesHarness): string[] {
  return fakeMessages(h).flatMap((message) => (message.type === "request" ? [message.op.op] : []));
}

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
      .request({ op: "closeRoot", root: 1 })
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
    const h = harness("hang");
    await h.files.start();
    const controller = new AbortController();
    const pending = h.files.request({ op: "closeRoot", root: 1 }, { signal: controller.signal });
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

  it("kills a process that sends an oversize frame and restarts it", async () => {
    const h = harness("oversize");
    void h.files.start().catch(() => {});
    await until(() => fakeSpawnCount(h) === 1);
    await until(() => h.files.state() === "down");
    await h.clock.advance(250);
    await until(() => fakeSpawnCount(h) === 2);
  });
});
