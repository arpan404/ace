import { afterEach, expect, test } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitService } from "@ace/git";
import type { ThreadId } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
function setup(options: Parameters<typeof transitionHarness>[0] = {}) {
  const h = transitionHarness(options);
  cleanup.push(h.close);
  return h;
}
function send(h: ReturnType<typeof setup>, threadId: ThreadId, text: string) {
  return h.command({
    type: "thread.send",
    threadId,
    input: [{ type: "text", text }],
    delivery: "queue",
  });
}

test("a queued switch precedes input queued earlier during the current turn", async () => {
  const h = setup();
  const id = await h.create();
  const nativeId = h.sessions[0]?.nativeId;
  h.held.add(id);
  send(h, id, "current turn");
  await h.engine.flush();
  expect(send(h, id, "queued before switch").ok).toBe(true);
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "codex", model: "model-b" },
  });
  await h.engine.flush();
  expect(h.inputs.at(-1)?.text).toBe("current turn");
  h.held.delete(id);
  h.emit(id, { type: "turn.ended", agent: "root", outcome: "completed" });
  await h.engine.flush();
  expect(h.inputs.at(-1)).toMatchObject({
    text: "queued before switch",
    model: "model-b",
    nativeId,
  });
});

test("forking an earlier turn after returning to its provider uses that turn's native session", async () => {
  const h = setup({ native: true });
  const id = await h.create();
  send(h, id, "original Codex private history");
  await h.engine.flush();
  const point = h.finishedRun(id);
  const sourceNative = h.inputs.at(-1)?.nativeId;
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
  await h.engine.flush();
  send(h, id, "later Claude turn");
  await h.engine.flush();
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "codex" } });
  await h.engine.flush();
  send(h, id, "second Codex session secret");
  await h.engine.flush();
  expect(h.inputs.at(-1)?.nativeId).not.toBe(sourceNative);
  const fork = await h.fork(id, { type: "turn", runId: point.id });
  expect(h.sessions.at(-1)?.context.fork?.nativeSessionId).toBe(sourceNative);
  const answer = h.store.readItemPage(fork, h.store.headSeq() + 1, 1).items[0];
  expect(answer?.type === "message" ? answer.parts : []).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("original Codex private history") }),
    ]),
  );
  expect(JSON.stringify(answer)).not.toContain("second Codex session secret");
});

test("whole-session fork creation guards its source until the native snapshot is opened", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = setup({
    native: true,
    forkPoints: ["end"],
    beforeFork: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const source = await h.create();
  const point = h.finishedRun(source);
  const accepted = h.command({
    type: "thread.fork",
    threadId: source,
    point: { type: "turn", runId: point.id },
    input: "branch",
  });
  expect(accepted.ok).toBe(true);
  try {
    await entered.promise;
    expect(send(h, source, "racing source secret")).toMatchObject({
      ok: false,
      error: "thread_transition_in_progress",
    });
  } finally {
    release.resolve();
    await h.engine.flush();
  }
  if (!accepted.forkThreadId) throw new Error("Missing fork identity");
  const answer = h.store.readItemPage(accepted.forkThreadId, h.store.headSeq() + 1, 1).items[0];
  expect(JSON.stringify(answer)).not.toContain("racing source secret");
  expect(send(h, source, "source resumes after snapshot").ok).toBe(true);
  await h.engine.flush();
  expect(h.inputs.at(-1)?.text).toBe("source resumes after snapshot");
});

test("completed idle switches return engine capacity before another thread is created", async () => {
  const h = setup({ maxActiveThreads: 2 });
  for (let index = 0; index < 6; index++) {
    const id = await h.create();
    h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
    await h.engine.flush();
    expect(h.store.getThread(id)?.switch?.state).toBe("applied");
  }
  expect(h.store.listThreads()).toHaveLength(6);
});

test("merge context admission rejects an escaped summary before changing git files", async () => {
  const git = new GitService();
  cleanup.push(() => git.close());
  const h = setup({
    io: {
      applyPatch: (request) => git.applyPatch(request),
      migrate: async () => ({ status: "refused", reason: "unused" }),
    },
  });
  await promisify(execFile)("git", ["init", h.home]);
  await writeFile(join(h.home, "file.txt"), "before\n");
  const source = await h.create();
  const fork = await h.fork(source);
  const cited = h.store.readItemPage(fork, h.store.headSeq() + 1, 1).items[0];
  if (!cited) throw new Error("Missing fork context");
  expect(
    h.command({
      type: "thread.merge",
      threadId: fork,
      summary: "\0".repeat(16384),
      citations: [{ threadId: fork, itemId: cited.id }],
      patch:
        "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(await readFile(join(h.home, "file.txt"), "utf8")).toBe("before\n");
  const items = h.store.readItemPage(source, h.store.headSeq() + 1, 50).items;
  expect(items.some((item) => item.type === "message" && item.mergedContext)).toBe(false);
  expect(
    items.some((item) => item.type === "notice" && item.text.startsWith("thread.merge:")),
  ).toBe(true);
});
