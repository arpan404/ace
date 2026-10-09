import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { checkedSessionReference } from "@ace/adapter-pi/session-header";
import {
  environment,
  jsonl,
  claudeRecords,
  codexRecords,
  cwd,
  init,
  memorySink,
  text,
  nativeId,
  otherId,
} from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const env = await environment();
  cleanup.push(env.close);
  return env;
}

test("an oversized legacy OpenCode message makes only its session unsupported and other sessions still import", async () => {
  const env = await fixture();
  const home = join(env.root, "opencode");
  for (const id of ["huge", "readable"]) {
    await jsonl(join(home, "storage/session/project", id + ".json"), [
      { id, directory: cwd, title: "New session", time: { created: 1, updated: 2 } },
    ]);
    await jsonl(join(home, "storage/message", id, "message.json"), [
      {
        id: "message",
        role: "user",
        ...(id === "huge" ? { legacy: "x".repeat(180000) } : {}),
        time: { created: 1 },
      },
    ]);
    await jsonl(join(home, "storage/part/message", "part.json"), [
      { type: "text", text: "Fix the reconnect loop" },
    ]);
  }
  const service = await env.start([{ id: "opencode", provider: "opencode", homeDir: home }]);
  const scan = await service.scan();
  expect(scan.unsupported).toContainEqual({
    instanceId: "opencode",
    reason: expect.stringContaining("too large"),
  });
  const all = (await service.list({ type: "history.list", cwd })).sessions;
  expect(all.find((s) => s.nativeId === "huge")?.support.status).toBe("unsupported");
  const openable = (await service.list({ type: "history.list", cwd, openableOnly: true })).sessions;
  expect(openable.map((s) => s.nativeId)).toEqual(["readable"]);
  const source = openable[0];
  if (!source) throw new Error("Missing readable session");
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(text(sink.items)).toContain("Fix the reconnect loop");
  expect((await service.scan()).reads).toBe(0);
});

test("attachment envelopes anywhere in a saved prompt never become titles or imported message text", async () => {
  const env = await fixture();
  const home = join(env.root, "claude");
  const prompt =
    '[Image: image.png; ref=image_synthetic] Fix the retry loop\n[Attached image "image.png" is saved at: /synthetic/.t3/userdata/attachments/image.png]\nname: image.png\nmimeType: image/png\nsizeBytes: 1234\nattachmentId: synthetic\nKeep the useful explanation.';
  await jsonl(join(home, "projects/p", "prompt.jsonl"), claudeRecords(prompt));
  const service = await env.start([{ id: "claude", provider: "claude", homeDir: home }]);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing session");
  expect(source.title).toBe("Fix the retry loop Keep the useful explanation.");
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(text(sink.items)).toContain("Keep the useful explanation.");
  expect(text(sink.items)).not.toMatch(
    /\[Image|Attached image|mimeType|attachmentId|sizeBytes|name: image/,
  );
});

test("copies of the same native session appear once across pages while same-title conversations remain separate", async () => {
  const env = await fixture();
  const home = join(env.root, "codex");
  for (const path of ["sessions/a.jsonl", "sessions/b.jsonl", "archived_sessions/c.jsonl"])
    await jsonl(join(home, path), codexRecords());
  await jsonl(join(home, "sessions/another.jsonl"), [
    { type: "session_meta", payload: { id: "22222222-2222-4222-8222-222222222222", cwd } },
    ...codexRecords().slice(1),
  ]);
  const service = await env.start([{ id: "codex", provider: "codex", homeDir: home }]);
  await service.scan();
  const first = await service.list({ type: "history.list", cwd, limit: 1 });
  if (!first.next) throw new Error("Missing next page");
  const second = await service.list({ type: "history.list", cwd, limit: 1, before: first.next });
  expect(second.next).toBeNull();
  expect(first.sessions[0]?.nativeId).not.toBe(second.sessions[0]?.nativeId);
});

test("readable copies of a saved agent tree win over unsupported duplicates and import once", async () => {
  const env = await fixture();
  const home = join(env.root, "codex");
  for (const child of [false, true]) {
    for (const unsupported of [false, true]) {
      await jsonl(join(home, "sessions", `${child}-${unsupported}.jsonl`), [
        {
          type: "session_meta",
          payload: {
            id: child ? otherId : nativeId,
            cwd,
            ...(child ? { parent_thread_id: nativeId } : {}),
            ...(unsupported ? { history_mode: "external" } : {}),
          },
        },
        ...codexRecords().slice(1),
      ]);
    }
  }
  const service = await env.start([{ id: "codex", provider: "codex", homeDir: home }]);
  await service.scan();
  const page = await service.list({ type: "history.list", cwd, openableOnly: true });
  expect(page.sessions).toHaveLength(1);
  const source = page.sessions[0];
  if (!source) throw new Error("Missing readable tree");
  expect(source.support.status).toBe("supported");
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(sink.agents).toHaveLength(2);
  expect(text(sink.items).match(/codex answer/g)).toHaveLength(2);
});

test("Codex bookkeeping and encrypted reasoning retain raw records without placeholder text", async () => {
  const env = await fixture();
  const home = join(env.root, "codex");
  const hidden = [
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "turn_context", payload: { model: "bare-model", cwd } },
    {
      type: "response_item",
      payload: { type: "reasoning", summary: [], encrypted_content: "synthetic-encrypted-data" },
    },
  ];
  await jsonl(join(home, "sessions/a.jsonl"), [
    ...codexRecords(),
    ...hidden,
    {
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Check the version file." }],
        encrypted_content: "synthetic",
      },
    },
  ]);
  const service = await env.start([{ id: "codex", provider: "codex", homeDir: home }]);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing session");
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  for (const record of hidden)
    expect(sink.items).toContainEqual(
      expect.objectContaining({
        type: "notice",
        code: "history.raw-only",
        text: "",
        raw: [expect.objectContaining({ data: record })],
      }),
    );
  expect(
    sink.items
      .filter((i) => i.type === "notice")
      .map((i) => i.text)
      .join(" "),
  ).not.toMatch(/Native reasoning record|Native history record: (event_msg|turn_context)/);
  expect(sink.items).toContainEqual(
    expect.objectContaining({ type: "reasoning", text: "Check the version file." }),
  );
});

test("Pi sessions are discovered and import the selected conversation branch", async () => {
  const env = await fixture();
  const home = join(env.root, "pi");
  const skills = join(env.root, "agents/skills/tdd");
  await mkdir(skills, { recursive: true });
  await writeFile(
    join(skills, "SKILL.md"),
    "Synthetic linked skill. This is not a saved conversation.",
  );
  await mkdir(join(home, "skills"), { recursive: true });
  await symlink(skills, join(home, "skills/tdd"));
  await jsonl(join(home, "sessions/project", "pi.jsonl"), [
    { type: "session", version: 3, id: "pi-session", cwd },
    {
      type: "model_change",
      id: "model",
      parentId: null,
      provider: "openai-codex",
      modelId: "gpt-5.4",
    },
    {
      type: "message",
      id: "ask",
      parentId: "model",
      message: { role: "user", content: "Find the app version" },
    },
    {
      type: "message",
      id: "abandoned",
      parentId: "ask",
      message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }] },
    },
    {
      type: "message",
      id: "selected",
      parentId: "ask",
      message: { role: "assistant", content: [{ type: "text", text: "The version is 0.1.0." }] },
    },
    { type: "session_info", id: "info", parentId: "selected", name: "Find app version" },
  ]);
  const service = await env.start([{ id: "pi", provider: "pi", homeDir: home }]);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing Pi session");
  expect(source).toMatchObject({
    provider: "pi",
    nativeId: "pi-session",
    title: "Find app version",
    model: "gpt-5.4",
  });
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(text(sink.items)).toContain("The version is 0.1.0.");
  expect(text(sink.items)).not.toContain("abandoned answer");
  const continuation = await service.continuation(source.id, "resume");
  expect(await checkedSessionReference(continuation.resume.nativeSessionId)).toEqual({
    path: join(home, "sessions/project/pi.jsonl"),
    id: "pi-session",
    cwd,
  });
  expect(sink.thread?.imported?.native.nativeId).toBe(continuation.resume.nativeSessionId);
});
