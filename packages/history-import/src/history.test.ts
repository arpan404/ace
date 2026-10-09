import { afterEach, expect, test } from "vitest";
import { appendFile, readFile, unlink, symlink, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readJsonLines, object } from "@ace/native-session";
import {
  environment,
  jsonl,
  claudeRecords,
  codexRecords,
  nativeId,
  otherId,
  cwd,
  init,
  memorySink,
  text,
} from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(provider: "claude" | "codex" = "claude") {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, provider);
  const path =
    provider === "claude"
      ? join(home, "projects/-workspace-project", nativeId + ".jsonl")
      : join(home, "sessions/2026/01/01/rollout-x.jsonl");
  await jsonl(path, provider === "claude" ? claudeRecords() : codexRecords());
  const service = await env.start([{ id: "account", provider, homeDir: home }]);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing source");
  return { ...env, home, path, service, source };
}
test("workspace lists retain native metadata and imports retain resumable provenance", async () => {
  const { service, source } = await setup();
  expect(source).toMatchObject({
    title: "hello",
    cwd,
    provider: "claude",
    model: "claude-model",
    messageCount: 2,
    countAccuracy: "exact",
  });
  const result = await service.importSession(init(source.id));
  expect(result.messageCount).toBe(2);
  const thread = await service.importedThread(init(source.id).threadId);
  expect(thread?.imported).toMatchObject({
    instanceId: "account",
    native: { provider: "claude", nativeId },
  });
  expect(thread).toMatchObject({
    status: { state: "done" },
    settledAt: init(source.id).at,
    unread: false,
  });
  expect(text((await service.itemsPage({ threadId: init(source.id).threadId })).items)).toBe(
    "hello answer",
  );
  expect((await service.importedAgents(init(source.id).threadId))[0]?.status.state).toBe("idle");
  expect(await service.continuation(source.id, "resume")).toMatchObject({
    instanceId: "account",
    cwd,
    resume: { nativeSessionId: nativeId },
  });
  expect(await service.continuation(source.id, "fork", async () => otherId)).toMatchObject({
    resume: { nativeSessionId: otherId },
  });
  await expect(service.continuation(source.id, "fork")).rejects.toThrow("fork capability");
});
test("warm scans read zero content and a changed source is the only content reread", async () => {
  const { service, path, source } = await setup();
  expect(await service.scan()).toMatchObject({ reads: 0, skipped: 1, bytes: 0 });
  await appendFile(
    path,
    JSON.stringify({ type: "ai-title", sessionId: nativeId, aiTitle: "new title" }) + "\n",
  );
  expect(await service.scan()).toMatchObject({ reads: 1, skipped: 0 });
  expect((await service.get(source.id))?.title).toBe("new title");
});
test("the persisted index skips content after a worker restart", async () => {
  const { service, start, home } = await setup();
  await service.close();
  const restarted = await start([{ id: "account", provider: "claude", homeDir: home }]);
  expect(await restarted.scan()).toMatchObject({ reads: 0, skipped: 1 });
});
test("removed sessions disappear only after a completed scan", async () => {
  const { service, path, source } = await setup();
  await unlink(path);
  await service.scan();
  expect(await service.get(source.id)).toBeNull();
});
test("partial tails are retained without losing preceding messages or changing source bytes", async () => {
  const { service, path, source } = await setup();
  await appendFile(path, '{"type":"assistant","message":');
  await service.scan();
  const before = await readFile(path);
  await service.importSession(init(source.id));
  expect(text((await service.itemsPage({ threadId: init(source.id).threadId })).items)).toContain(
    "hello answer",
  );
  expect(
    (await service.itemsPage({ threadId: init(source.id).threadId })).items.some(
      (i) => i.type === "notice" && i.text.includes("incomplete JSON"),
    ),
  ).toBe(true);
  expect(await readFile(path)).toEqual(before);
});
test("valid final records without a newline are imported", async () => {
  const { service, path, source } = await setup();
  await appendFile(
    path,
    JSON.stringify({
      type: "user",
      sessionId: nativeId,
      cwd,
      message: { role: "user", content: "last message" },
    }),
  );
  await service.scan();
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(text(sink.items)).toContain("last message");
});
test("instance homes keep identical native session IDs separate", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const a = join(env.root, "a"),
    b = join(env.root, "b");
  await jsonl(join(a, "projects/p", nativeId + ".jsonl"), claudeRecords("account A"));
  await jsonl(join(b, "projects/p", nativeId + ".jsonl"), claudeRecords("account B"));
  const service = await env.start([
    { id: "A", provider: "claude", homeDir: a },
    { id: "B", provider: "claude", homeDir: b },
  ]);
  expect((await service.scan()).reads).toBe(2);
  const sessions = (await service.list({ type: "history.list", cwd })).sessions;
  expect(new Set(sessions.map((s) => s.id)).size).toBe(2);
  expect(sessions.map((s) => s.instanceId).toSorted()).toEqual(["A", "B"]);
});
test("Claude sidechains become child agents and changes are indexed independently", async () => {
  const { service, home, source } = await setup();
  const side = join(home, "projects/-workspace-project", nativeId, "subagents/agent-child.jsonl");
  await jsonl(side, claudeRecords("child prompt"));
  expect((await service.scan()).reads).toBe(1);
  expect((await service.list({ type: "history.list", cwd })).sessions).toHaveLength(1);
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(sink.agents).toHaveLength(2);
  expect(sink.agents[1]?.parentId).toBe(sink.agents[0]?.id);
  expect(text(sink.items)).toContain("child prompt");
});
test("Codex rollouts import messages and native tools without changing source bytes", async () => {
  const { service, path, source } = await setup("codex");
  const before = await readFile(path);
  const sink = memorySink();
  expect(source).toMatchObject({ title: "codex prompt", model: "codex-model", messageCount: 2 });
  await service.importSession(init(source.id), sink);
  expect(text(sink.items)).toContain("codex answer");
  expect(sink.items.some((i) => i.type === "tool_call" && i.call.title === "exec_command")).toBe(
    true,
  );
  expect(await readFile(path)).toEqual(before);
});
test("unknown native records survive as canonical raw notices", async () => {
  const { service, path, source } = await setup();
  const unknown = { type: "future-record", novel: { keep: "everything" } };
  await appendFile(path, JSON.stringify(unknown) + "\n");
  await service.scan();
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(
    sink.items.some(
      (i) =>
        i.type === "notice" &&
        i.raw.some(
          (r) => JSON.stringify("data" in r ? r.data : undefined) === JSON.stringify(unknown),
        ),
    ),
  ).toBe(true);
});
test("Codex forks referencing another history file explain why a complete import is refused", async () => {
  const { service, path } = await setup("codex");
  await jsonl(path, [
    {
      type: "session_meta",
      payload: {
        id: nativeId,
        cwd,
        history_mode: "paginated",
        history_base: { thread_id: otherId, ordinal: 10 },
      },
    },
    ...codexRecords().slice(1),
  ]);
  await service.scan();
  const s = (await service.list({ type: "history.list", cwd })).sessions[0];
  expect(s?.support).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("another file"),
  });
  if (!s) throw new Error("missing source");
  await expect(service.importSession(init(s.id))).rejects.toThrow("another file");
});
test("Cursor discovery reports the missing full-history and ACP contracts", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const service = await env.start([
    { id: "cursor", provider: "cursor", homeDir: join(env.root, "cursor") },
  ]);
  expect((await service.scan()).unsupported).toEqual([
    { instanceId: "cursor", reason: expect.stringContaining("tool outputs") },
  ]);
});
test("changed sources refuse import before publishing a thread", async () => {
  const { service, path, source } = await setup();
  await appendFile(path, "{}\n");
  await expect(service.importSession(init(source.id))).rejects.toThrow("rescan");
  expect(await service.importedThread(init(source.id).threadId)).toBeNull();
});
test("source changes during import roll back all staged history", async () => {
  const { service, path, source } = await setup();
  const sink = service.archiveSink();
  let changed = false;
  await expect(
    service.importSession(init(source.id), {
      ...sink,
      appendItem: async (item) => {
        await sink.appendItem(item);
        if (!changed) {
          changed = true;
          await appendFile(path, "{}\n");
        }
      },
    }),
  ).rejects.toThrow("changed");
  expect(await service.importedThread(init(source.id).threadId)).toBeNull();
  await service.scan();
  await service.importSession(init(source.id));
  expect(await service.importedThread(init(source.id).threadId)).not.toBeNull();
});
test("sink failure rolls back and permits a later import", async () => {
  const { service, source } = await setup();
  const sink = service.archiveSink();
  await expect(
    service.importSession(init(source.id), {
      ...sink,
      appendItem: async () => {
        throw new Error("disk full");
      },
    }),
  ).rejects.toThrow("disk full");
  expect(await service.importedThread(init(source.id).threadId)).toBeNull();
  await service.importSession(init(source.id));
});
test("cancellation rolls back while a slow sink enforces pull backpressure", async () => {
  const { service, source } = await setup();
  const controller = new AbortController();
  const sink = service.archiveSink();
  let writes = 0;
  await expect(
    service.importSession(
      init(source.id),
      {
        ...sink,
        appendItem: async (item) => {
          writes++;
          await sink.appendItem(item);
          controller.abort();
        },
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(writes).toBe(1);
  expect(await service.importedThread(init(source.id).threadId)).toBeNull();
  await service.importSession(init(source.id));
});
test("workspace cursors page without duplicates and hide unrelated workspaces", async () => {
  const { service, home } = await setup();
  await jsonl(join(home, "projects/p", otherId + ".jsonl"), claudeRecords("second", otherId));
  await jsonl(join(home, "projects/q", "third.jsonl"), [
    {
      type: "user",
      sessionId: "third",
      cwd: "/another",
      message: { role: "user", content: "elsewhere" },
    },
  ]);
  await service.scan();
  const first = await service.list({ type: "history.list", cwd, limit: 1 });
  if (!first.next) throw new Error("missing cursor");
  const second = await service.list({ type: "history.list", cwd, limit: 1, before: first.next });
  expect(second.next).toBeNull();
  expect(first.sessions[0]?.id).not.toBe(second.sessions[0]?.id);
});
test("oversized records stream losslessly into bounded blob chunks and pages", async () => {
  const { service, path, source } = await setup();
  const large = JSON.stringify({
    type: "assistant",
    sessionId: nativeId,
    message: { role: "assistant", content: "x".repeat(3 * 1024 * 1024) },
  });
  await appendFile(path, large + "\n");
  await service.scan();
  const sink = service.archiveSink();
  let maxChunk = 0;
  await service.importSession(init(source.id), {
    ...sink,
    appendBlob: async (id, bytes) => {
      maxChunk = Math.max(maxChunk, bytes.length);
      await sink.appendBlob(id, bytes);
    },
  });
  expect(maxChunk).toBeLessThanOrEqual(64 * 1024);
  const page = await service.itemsPage({ threadId: init(source.id).threadId });
  const entry = page.items.find((i) => i.type === "notice" && i.text.includes("oversized"));
  const raw = entry && entry.type === "notice" ? object(entry.raw[0]) : {};
  const id = String(raw.blobRef);
  const digest = createHash("sha256");
  let offset = 0;
  for (;;) {
    const chunk = await service.readBlob({ id, offset, limit: 9973 });
    digest.update(chunk.bytes);
    offset += chunk.bytes.length;
    if (offset >= chunk.size) break;
  }
  expect(digest.digest("hex")).toBe(createHash("sha256").update(large).digest("hex"));
  expect(
    (await service.readBlob({ id, offset: 3 * 1024 * 1024 + 1000, limit: 100 })).bytes.length,
  ).toBe(0);
});
test("fixture-derived Claude messages retain observed assistant text", async () => {
  const { service, path, source } = await setup();
  const fixture = new URL("../../../fixtures/claude/2.1.286/tool-read.jsonl", import.meta.url)
    .pathname;
  const messages: unknown[] = [];
  for await (const record of readJsonLines(
    new URL("../../../fixtures", import.meta.url).pathname,
    fixture,
  )) {
    if (!("value" in record)) continue;
    const data = object(object(record.value).data);
    if (data.type === "assistant" || data.type === "user")
      messages.push({ ...data, sessionId: nativeId, cwd });
  }
  expect(messages.length).toBeGreaterThan(0);
  await jsonl(path, messages);
  await service.scan();
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  const expected = messages.flatMap((m) => {
    const content = object(object(m).message).content;
    return Array.isArray(content)
      ? content.flatMap((p) => (typeof object(p).text === "string" ? [object(p).text] : []))
      : [];
  });
  expect(expected.length).toBeGreaterThan(0);
  for (const value of expected) expect(text(sink.items)).toContain(value);
});
test("symlinks are neither discovered nor opened as session sources", async () => {
  const { service, path, source } = await setup();
  const outside = join((await setup()).root, "secret.jsonl");
  await writeFile(outside, '{"secret":"private"}\n');
  await unlink(path);
  await symlink(outside, path);
  await expect(service.importSession(init(source.id))).rejects.toThrow();
  await service.scan();
  expect(await service.get(source.id)).toBeNull();
});
test("provider homes cannot contain the ace index, including an index symlink", async () => {
  const env = await environment();
  cleanup.push(env.close);
  await mkdir(join(env.root, "ace"));
  await expect(env.start([{ id: "bad", provider: "claude", homeDir: env.root }])).rejects.toThrow(
    "outside provider homes",
  );
  const target = join(env.root, "target");
  await writeFile(target, "untouched");
  await symlink(target, join(env.root, "ace/index.sqlite"));
  await expect(env.start([])).rejects.toThrow("regular file");
  expect(await readFile(target, "utf8")).toBe("untouched");
});
