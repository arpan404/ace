import { afterEach, expect, test } from "vitest";
import { PortableHandoff, McpScope, HandoffPage, ThreadId } from "@ace/protocol";
import { ToolRegistry } from "@ace/mcp-server";
import { handoffToolkit } from "../services/handoff-tools.ts";
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
async function cursor(h: ReturnType<typeof setup>) {
  expect(
    h.command({
      type: "thread.create",
      provider: "cursor",
      workspaceId: h.workspace,
      input: [{ type: "text", text: "source context" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const id = h.store.listThreads().find((thread) => thread.provider === "cursor")?.id;
  if (!id) throw new Error("Missing source thread");
  return id;
}

test("SDK portable forks keep the source checkpoint and resume their own pinned native identity", async () => {
  const h = setup({ cursorBackend: "cursor-sdk", configure: false });
  const source = await cursor(h);
  const native = h.sessions.at(-1)?.nativeId;
  const fork = await h.fork(source);
  const forkNative = h.sessions.at(-1)?.nativeId;
  expect(forkNative).not.toBe(native);
  expect(h.sessions.at(-1)?.context.fork).toBeUndefined();
  expect(h.store.getThread(fork)).toMatchObject({
    backend: "cursor-sdk",
    lineage: { mode: "portable", lossy: true },
  });
  expect(h.store.getThread(source)?.backend).toBe("cursor-sdk");
  const rendered = h.inputs.at(-1)?.text ?? "";
  const manifest = PortableHandoff.parse(
    JSON.parse(rendered.slice(0, rendered.indexOf("\ncontinue fork"))),
  );
  expect(manifest.origin).toEqual({ provider: "cursor", backend: "cursor-sdk" });
  expect(manifest.excerpts.some((entry) => entry.text.includes("source context"))).toBe(true);
  await h.restart();
  expect(
    h.command({
      type: "thread.send",
      threadId: fork,
      delivery: "queue",
      input: [{ type: "text", text: "after restart" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.resume).toMatchObject({
    backend: "cursor-sdk",
    nativeSessionId: forkNative,
    instanceId: "account-a",
  });
  expect(h.inputs.at(-1)?.nativeId).toBe(forkNative);
  expect(h.histories.get(native ?? "")?.map((entry) => entry.text)).toEqual(["source context"]);
});

test("SDK account switches refuse CLI checkpoint migration and retain the source native history", async () => {
  const h = setup({
    cursorBackend: "cursor-sdk",
    configure: false,
    io: {
      migrate: async () => {
        throw new Error("must never enter CLI migration");
      },
      applyPatch: async () => {},
    },
  });
  const id = await cursor(h);
  const native = h.sessions.at(-1)?.nativeId;
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "cursor", instanceId: "account-b" },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch).toMatchObject({
    state: "failed",
    error: expect.stringContaining("fresh portable fork"),
  });
  expect(h.store.getThread(id)?.execution?.instanceId).toBe("account-a");
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "queue",
      input: [{ type: "text", text: "source continues" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs.at(-1)?.nativeId).toBe(native);
  expect(h.histories.get(native ?? "")?.map((entry) => entry.text)).toEqual([
    "source context",
    "source continues",
  ]);
});

test("used Cursor CLI threads are read-only after restart and continue through a portable SDK handoff", async () => {
  const h = setup({ cursorBackend: "cursor-sdk", configure: false });
  const source = await cursor(h);
  const native = h.sessions.at(-1)?.nativeId;
  h.store.appendEvents(source, [{ type: "thread.updated", backend: "acp" }]);
  h.store.atomic((db) =>
    db
      .prepare(
        "UPDATE engine_sessions SET backend='acp',instance_id='cursor-cli-default' WHERE thread_id=?",
      )
      .run(source),
  );
  await h.restart();
  expect(h.store.getThread(source)?.continuation).toMatchObject({
    state: "read_only",
    actionId: "thread.continue_new",
  });
  expect(
    h.command({
      type: "thread.send",
      threadId: source,
      input: [{ type: "text", text: "old continuation" }],
      delivery: "queue",
    }),
  ).toMatchObject({ ok: false, error: "cursor_cli_retired" });
  expect(
    h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "cursor",
      handoffFrom: source,
      accountId: "cursor-cli-default",
      input: [{ type: "text", text: "continue here" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const recipient = h.store.listThreads().find((thread) => thread.id !== source);
  expect(recipient).toMatchObject({ backend: "cursor-sdk", handoff: { sourceThreadId: source } });
  expect(h.inputs.at(-1)?.text).toContain("source context");
  expect(h.inputs.at(-1)?.nativeId).not.toBe(native);
  expect(h.sessions.at(-1)?.context.resume).toBeUndefined();
  expect(h.sessions.at(-1)?.context.instanceId).toBe("cursor-sdk-default");
});

test("same-account SDK model changes retain native checkpoint history through close and resume", async () => {
  const h = setup({ cursorBackend: "cursor-sdk", configure: false });
  const id = await cursor(h);
  const native = h.sessions.at(-1)?.nativeId;
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "cursor", model: "composer-2.5" },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch).toMatchObject({ state: "applied", lossy: false });
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "queue",
      input: [{ type: "text", text: "after model selection" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.resume).toMatchObject({
    backend: "cursor-sdk",
    nativeSessionId: native,
    instanceId: "account-a",
  });
  expect(h.inputs.at(-1)).toMatchObject({ nativeId: native, model: "composer-2.5" });
  expect(h.histories.get(native ?? "")?.map((entry) => entry.text)).toEqual([
    "source context",
    "after model selection",
  ]);
});

test("switching into Cursor SDK starts fresh with portable context and resumes only the new checkpoint", async () => {
  const h = setup({ cursorBackend: "cursor-sdk", configure: false });
  const id = await h.create();
  const sourceNative = h.inputs.at(-1)?.nativeId;
  if (!sourceNative) throw new Error("Missing source native session");
  expect(
    h.command({ type: "thread.switch", threadId: id, selection: { provider: "cursor" } }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)).toMatchObject({
    provider: "cursor",
    backend: "cursor-sdk",
    switch: { state: "applied", lossy: true, recommendation: "delegate_task" },
  });
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "queue",
      input: [{ type: "text", text: "fresh SDK continuation" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const session = h.sessions.at(-1);
  if (!session) throw new Error("Missing fresh SDK session");
  const native = session.nativeId;
  expect(native).not.toBe(sourceNative);
  expect(session.context.resume).toBeUndefined();
  expect(session.context.fork).toBeUndefined();
  const text = h.inputs.at(-1)?.text ?? "";
  const manifest = PortableHandoff.parse(
    JSON.parse(text.slice(0, text.indexOf("\nfresh SDK continuation"))),
  );
  expect(manifest.origin).toEqual({ provider: "codex" });
  expect(manifest.sourceThreadId).toBe(id);
  expect(manifest.excerpts.some((entry) => entry.text.includes("source history"))).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThanOrEqual(16384);
  expect(h.histories.get(sourceNative)?.map((entry) => entry.text)).toEqual(["source history"]);
  await h.restart();
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "queue",
      input: [{ type: "text", text: "SDK after restart" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.resume).toMatchObject({
    backend: "cursor-sdk",
    nativeSessionId: native,
  });
  expect(h.inputs.at(-1)).toMatchObject({ provider: "cursor", nativeId: native });
  expect(h.histories.get(sourceNative)?.map((entry) => entry.text)).toEqual(["source history"]);
});

test("switching out of Cursor SDK preserves its checkpoint and requires a fresh portable destination thread", async () => {
  const h = setup({ cursorBackend: "cursor-sdk", configure: false });
  const source = await cursor(h);
  const native = h.inputs.at(-1)?.nativeId;
  if (!native) throw new Error("Missing source SDK session");
  expect(
    h.command({ type: "thread.switch", threadId: source, selection: { provider: "codex" } }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(source)).toMatchObject({
    provider: "cursor",
    backend: "cursor-sdk",
    switch: { state: "failed", error: expect.stringContaining("source checkpoint is preserved") },
  });
  const before = new Set(h.store.listThreads().map((thread) => thread.id));
  expect(
    h.command({
      type: "thread.create",
      provider: "codex",
      workspaceId: h.workspace,
      handoffFrom: source,
      input: [{ type: "text", text: "fresh Codex continuation" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const recipient = h.store.listThreads().find((thread) => !before.has(thread.id));
  expect(recipient).toMatchObject({ provider: "codex", handoff: { sourceThreadId: source } });
  expect(h.inputs.at(-1)?.nativeId).not.toBe(native);
  expect(h.sessions.at(-1)?.context.resume).toBeUndefined();
  expect(h.sessions.at(-1)?.context.fork).toBeUndefined();
  const text = h.inputs.at(-1)?.text ?? "";
  const manifest = PortableHandoff.parse(
    JSON.parse(text.slice(0, text.indexOf("\nfresh Codex continuation"))),
  );
  expect(manifest.origin).toEqual({ provider: "cursor", backend: "cursor-sdk" });
  expect(manifest.excerpts.some((entry) => entry.text.includes("source context"))).toBe(true);
  expect(h.histories.get(native)?.map((entry) => entry.text)).toEqual(["source context"]);
  await h.restart();
  expect(
    h.command({
      type: "thread.send",
      threadId: source,
      delivery: "queue",
      input: [{ type: "text", text: "source continuation" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.resume).toMatchObject({
    backend: "cursor-sdk",
    nativeSessionId: native,
  });
  expect(h.inputs.at(-1)).toMatchObject({ provider: "cursor", nativeId: native });
});

test("SDK handoffFrom creates a fresh agent and grants frozen source history without copying native stores", async () => {
  const h = setup({ cursorBackend: "cursor-sdk", configure: false });
  const source = await h.create();
  const sourceNative = h.inputs.at(-1)?.nativeId;
  expect(
    h.command({
      type: "thread.create",
      provider: "cursor",
      workspaceId: h.workspace,
      handoffFrom: source,
      input: [{ type: "text", text: "continue SDK context" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const id = h.store.listThreads().find((thread) => thread.provider === "cursor")?.id;
  if (!id) throw new Error("Missing SDK handoff recipient");
  const text = h.inputs.at(-1)?.text ?? "";
  const manifest = PortableHandoff.parse(
    JSON.parse(text.slice(0, text.indexOf("\ncontinue SDK context"))),
  );
  expect(manifest.origin).toEqual({ provider: "codex" });
  expect(h.store.getThread(id)).toMatchObject({
    backend: "cursor-sdk",
    handoff: { sourceThreadId: source, bytes: Buffer.byteLength(JSON.stringify(manifest)) },
  });
  expect(h.inputs.at(-1)?.nativeId).not.toBe(sourceNative);
  expect(h.sessions.at(-1)?.context.resume).toBeUndefined();
  expect(
    h.command({
      type: "thread.send",
      threadId: source,
      delivery: "queue",
      input: [{ type: "text", text: "later secret" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  await h.restart();
  const tools = new ToolRegistry({ scheduler: { after: () => () => {} } });
  handoffToolkit(h.store).register(tools);
  const principal = {
    scope: McpScope.parse({
      sessionId: "recipient",
      threadId: id,
      agentId: h.store.getThread(id)?.rootAgentId,
      capabilities: [],
    }),
    signal: new AbortController().signal,
  };
  const response = await tools.call(
    manifest.history.tool,
    { sourceThreadId: source, before: h.store.headSeq() + 1, limit: 50 },
    principal,
    principal.signal,
  );
  const page = HandoffPage.parse(response.structuredContent);
  expect(JSON.stringify(page.items)).toContain("source history");
  expect(JSON.stringify(page.items)).not.toContain("later secret");
});

test("unused Cursor CLI threads migrate to SDK and accept their first message after restart", async () => {
  const h = setup({ configure: false });
  const result = h.command({
    type: "thread.prepare",
    provider: "cursor",
    workspaceId: h.workspace,
    accountId: "cursor-cli-default",
    threadId: ThreadId.parse("unused-cursor"),
    title: "Unused",
  });
  if (!result.ok || !result.threadId) throw new Error("Preparation failed");
  const id = result.threadId;
  h.store.appendEvents(id, [{ type: "thread.updated", backend: "acp" }]);
  h.store.atomic((db) =>
    db
      .prepare(
        "UPDATE engine_sessions SET backend='acp',instance_id='cursor-cli-default' WHERE thread_id=?",
      )
      .run(id),
  );
  await h.restart();
  expect(h.store.getThread(id)).toMatchObject({ backend: "cursor-sdk" });
  expect(h.store.getThread(id)?.continuation).toBeUndefined();
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "queue",
      input: [{ type: "text", text: "first SDK message" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs.at(-1)?.text).toBe("first SDK message");
  expect(h.sessions.at(-1)?.context).toMatchObject({ instanceId: "cursor-sdk-default" });
  expect(h.sessions.at(-1)?.context.resume).toBeUndefined();
});
