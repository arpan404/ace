import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { AccountService, createInstance, openRegistry } from "@ace/accounts";
import { GitService } from "@ace/git";
import { transitionHarness } from "./transition-test-support.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const exec = promisify(execFile);

test("cross-account switching migrates the native session and ancestors before forking in the destination", async () => {
  const ancestor = "11111111-1111-4111-8111-111111111111";
  const h = transitionHarness({
    native: true,
    io: {
      applyPatch: async () => {},
      async migrate(request) {
        const response = await accounts.handle({
          ...request,
          type: "accounts.migrate",
          requestId: "switch-migration",
        });
        if (response.type !== "accounts.migrate") throw new Error("Wrong response");
        return response.result;
      },
    },
  });
  cleanup.push(h.close);
  const registry = await openRegistry(join(h.home, "accounts.sqlite"));
  cleanup.push(async () => {
    registry.close();
  });
  const from = createInstance({
    id: "account-a",
    provider: "codex",
    label: "A",
    homeDir: join(h.home, "a"),
  });
  const to = createInstance({
    id: "account-b",
    provider: "codex",
    label: "B",
    homeDir: join(h.home, "b"),
  });
  await registry.register(from);
  await registry.register(to);
  const accounts = new AccountService({
    registry,
    now: () => 1000,
    timeZone: "UTC",
    env: {},
    safety: {
      acquire: async () =>
        h.sessions.some((session) => !session.closed) ? undefined : { release: async () => {} },
    },
  });
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  if (!original) throw new Error("No source native ID");
  const directory = join(from.homeDir, "sessions", "2026", "10", "02");
  await mkdir(directory, { recursive: true });
  const rootRelative = `sessions/2026/10/02/rollout-${original}.jsonl`;
  const ancestorRelative = `sessions/2026/10/02/rollout-${ancestor}.jsonl`;
  const rootBytes =
    JSON.stringify({
      type: "session_meta",
      payload: { id: original, session_id: original, forked_from_id: ancestor, cwd: h.home },
    }) + "\n";
  const parentBytes =
    JSON.stringify({
      type: "session_meta",
      payload: { id: ancestor, session_id: ancestor, cwd: h.home },
    }) + "\n";
  await writeFile(join(from.homeDir, rootRelative), rootBytes);
  await writeFile(join(from.homeDir, ancestorRelative), parentBytes);
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "codex", instanceId: "account-b" },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch).toMatchObject({
    state: "applied",
    lossy: false,
    selection: { instanceId: "account-b" },
  });
  expect(await readFile(join(to.homeDir, rootRelative), "utf8")).toBe(rootBytes);
  expect(await readFile(join(to.homeDir, ancestorRelative), "utf8")).toBe(parentBytes);
  expect(await readFile(join(from.homeDir, rootRelative), "utf8")).toBe(rootBytes);
  h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text: "continue on B" }],
    delivery: "queue",
  });
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.instanceId).toBe("account-b");
  expect(h.sessions.at(-1)?.context.fork?.nativeSessionId).toBe(original);
  expect(h.inputs.at(-1)?.nativeId).not.toBe(original);
  const answers = h.store
    .readItemPage(id, h.store.headSeq() + 1, 1)
    .items.flatMap((item) => (item.type === "message" ? item.parts : []));
  expect(answers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("source history") }),
    ]),
  );
  expect(answers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("answer: continue on B") }),
    ]),
  );
});

test("merge patches use git validation and duplicate command receipts do not apply them twice", async () => {
  const git = new GitService();
  cleanup.push(() => git.close());
  const h = transitionHarness({
    io: {
      applyPatch: (request) => git.applyPatch(request),
      migrate: async () => ({ status: "refused", reason: "unused" }),
    },
  });
  cleanup.push(h.close);
  await exec("git", ["init", h.home]);
  await writeFile(join(h.home, "file.txt"), "before\n");
  const source = await h.create();
  const fork = await h.fork(source);
  const item = Object.values(h.store.snapshotThread(fork).items).find(
    (candidate) => candidate.type === "message",
  );
  if (!item) throw new Error("No fork result");
  const payload = {
    type: "thread.merge" as const,
    threadId: fork,
    summary: "Change file to after",
    citations: [{ threadId: fork, itemId: item.id }],
    patch:
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n",
  };
  const first = h.command(payload, "merge-once");
  expect(first.ok).toBe(true);
  await h.engine.flush();
  expect(await readFile(join(h.home, "file.txt"), "utf8")).toBe("after\n");
  expect(h.command(payload, "merge-once")).toEqual(first);
  await h.engine.flush();
  expect(
    Object.values(h.store.snapshotThread(source).items).filter(
      (candidate) => candidate.type === "message" && candidate.synthetic,
    ),
  ).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

test("pending patch merges guard both trees until git finishes and then release them", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = transitionHarness({
    io: {
      migrate: async () => ({ status: "refused", reason: "unused" }),
      applyPatch: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  });
  cleanup.push(h.close);
  const source = await h.create();
  const fork = await h.fork(source);
  const item = Object.values(h.store.snapshotThread(fork).items).find(
    (candidate) => candidate.type === "message",
  );
  if (!item) throw new Error("No fork result");
  h.command({
    type: "thread.merge",
    threadId: fork,
    summary: "Guarded merge",
    citations: [{ threadId: fork, itemId: item.id }],
    patch: "synthetic bounded patch",
  });
  try {
    await entered.promise;
    expect(
      h.sessions
        .filter(
          (session) => session.context.threadId === source || session.context.threadId === fork,
        )
        .every((session) => session.closed),
    ).toBe(true);
    for (const threadId of [source, fork])
      expect(
        h.command({
          type: "thread.send",
          threadId,
          input: [{ type: "text", text: "racing send" }],
          delivery: "steer",
        }),
      ).toMatchObject({ ok: false, error: "thread_transition_in_progress" });
  } finally {
    release.resolve();
    await h.engine.flush();
  }
  for (const threadId of [source, fork])
    expect(
      h.command({
        type: "thread.send",
        threadId,
        input: [{ type: "text", text: "after merge" }],
        delivery: "queue",
      }).ok,
    ).toBe(true);
  await h.engine.flush();
});
