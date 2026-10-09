import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import {
  environment,
  jsonl,
  codexRecords,
  claudeRecords,
  cwd,
  init,
  memorySink,
  text,
} from "./test-support.ts";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { mkdir } from "node:fs/promises";
import { object } from "@ace/native-session";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test("Claude image sources and OpenCode file images are readable attachments after import", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const claude = join(env.root, "claude");
  const image = "data:image/png;base64,aW1hZ2U=";
  await jsonl(join(claude, "projects/p/a.jsonl"), [
    ...claudeRecords(),
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
        ],
      },
    },
  ]);
  const opencode = join(env.root, "opencode");
  await mkdir(opencode);
  const db = new DatabaseSync(join(opencode, "opencode.db"));
  db.exec(`CREATE TABLE session(id TEXT,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,data TEXT);`);
  db.prepare("INSERT INTO session VALUES('native',?,'Title request: Review image',1,NULL)").run(
    cwd,
  );
  db.prepare("INSERT INTO session_message VALUES('message','native','user',1,?)").run(
    JSON.stringify({
      text: "Review image",
      files: [{ type: "file", mime: "image/png", url: image }],
    }),
  );
  db.close();
  const service = await env.start([
    { id: "claude", provider: "claude", homeDir: claude },
    { id: "opencode", provider: "opencode", homeDir: opencode },
  ]);
  await service.scan();
  const page = await service.list({ type: "history.list", cwd });
  expect(page.sessions).toHaveLength(2);
  for (const session of page.sessions) {
    const sink = memorySink();
    await service.importSession(init(session.id), sink);
    expect(sink.items).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "user",
        parts: [{ type: "image", mimeType: "image/png", url: image }],
      }),
    );
  }
});

test("a copied provider session appears once across project paths while distinct sessions keep identical titles", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "claude");
  await jsonl(join(home, "projects/p/a.jsonl"), claudeRecords("Shared title", "native"));
  await jsonl(
    join(home, "projects/p/copy.jsonl"),
    claudeRecords("Shared title", "native").map((r) =>
      Object.assign(object(r), { cwd: "/another/project" }),
    ),
  );
  await jsonl(join(home, "projects/p/different.jsonl"), claudeRecords("Shared title", "different"));
  const service = await env.start([{ id: "claude", provider: "claude", homeDir: home }]);
  await service.scan();
  const rows = [
    ...(await service.list({ type: "history.list", cwd })).sessions,
    ...(await service.list({ type: "history.list", cwd: "/another/project" })).sessions,
  ];
  expect(rows.map((row) => row.nativeId).toSorted()).toEqual(["different", "native"]);
  expect(rows.map((row) => row.title)).toEqual(["Shared title", "Shared title"]);
});

test("an oversized first request is marked unavailable while another conversation remains usable", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "claude");
  await jsonl(join(home, "projects/p/large.jsonl"), [
    { type: "system", context: "x".repeat(160000) },
    ...claudeRecords("x".repeat(180000), "large"),
  ]);
  await jsonl(join(home, "projects/p/good.jsonl"), claudeRecords("Useful request", "good"));
  const service = await env.start([{ id: "claude", provider: "claude", homeDir: home }]);
  await service.scan();
  const page = await service.list({ type: "history.list", cwd });
  expect(page.sessions.find((row) => row.nativeId === "large")?.support.status).toBe("unsupported");
  const good = page.sessions.find((row) => row.nativeId === "good");
  if (!good) throw new Error("Missing usable session");
  const sink = memorySink();
  await service.importSession(init(good.id), sink);
  expect(text(sink.items)).toContain("Useful request");
});
const wrappers = [
  "The user interrupted the previous turn on purpose. Any running unified exec processes were terminated. If any tools/commands were aborted, they may have executed partially; verify current state before retrying.",
  "A previous agent produced the plan below. Use it to continue the task.\n# Plan\nInjected plan text",
  "Continue this conversation using the transcript context below.\n<transcript>Injected context</transcript>",
  "[User attached one or more images. The images are available in the conversation.]",
];

test.each([
  ...wrappers,
  ...wrappers.map(
    (wrapper) => `<environment_context>Injected environment</environment_context>\n${wrapper}`,
  ),
])("an injected wrapper is skipped in favour of the next person's request: %s", async (wrapper) => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "codex");
  const records = codexRecords();
  await jsonl(join(home, "sessions/a.jsonl"), [
    records[0],
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: wrapper }],
      },
    },
    ...records.slice(1),
  ]);
  const service = await env.start([{ id: "codex", provider: "codex", homeDir: home }]);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing conversation");
  expect(source.title).toBe("codex prompt");
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(text(sink.items)).not.toContain(wrapper);
  expect(text(sink.items)).toContain("codex prompt");
});

test("image-only messages import as images and bookkeeping stays hidden while keeping raw records", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "codex");
  const image = "data:image/png;base64,aW1hZ2U=";
  await jsonl(join(home, "sessions/a.jsonl"), [
    ...codexRecords(),
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "internal context" }],
    },
    { type: "world_state", payload: { synthetic: true } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: image }],
      },
    },
  ]);
  const service = await env.start([{ id: "codex", provider: "codex", homeDir: home }]);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing conversation");
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(sink.items).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "user",
      parts: [{ type: "image", mimeType: "image/png", url: image }],
    }),
  );
  expect(
    sink.items
      .filter((i) => i.type === "notice" && i.code !== "history.raw-only")
      .flatMap((i) => (i.type === "notice" ? [i.text] : []))
      .join(" "),
  ).not.toMatch(/Native history record|Native content block|Native message/);
});
