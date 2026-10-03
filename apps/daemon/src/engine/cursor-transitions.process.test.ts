import { afterEach, expect, test } from "vitest";
import { PortableHandoff, McpScope, HandoffPage } from "@ace/protocol";
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

test("old ACP Cursor resume and model changes keep ACP after the default changes to SDK", async () => {
  const h = setup({ configure: false });
  const source = await cursor(h);
  const native = h.sessions.at(-1)?.nativeId;
  const acp = h.registry.get("cursor", "acp").adapter;
  h.registry.register(
    { ...acp, backend: "cursor-sdk" },
    { installed: true, auth: "logged_in", loginHint: "synthetic" },
  );
  await h.restart();
  expect(
    h.command({
      type: "thread.switch",
      threadId: source,
      selection: { provider: "cursor", model: "old-acp-model" },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(
    h.command({
      type: "thread.send",
      threadId: source,
      delivery: "queue",
      input: [{ type: "text", text: "ACP continuation" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.resume).toMatchObject({
    backend: "acp",
    nativeSessionId: native,
  });
  expect(h.inputs.at(-1)).toMatchObject({ nativeId: native, model: "old-acp-model" });
  expect(h.store.getThread(source)?.backend).toBe("acp");
  const fork = await h.fork(source);
  expect(h.store.getThread(fork)?.backend).toBe("cursor-sdk");
  expect(h.sessions.at(-1)?.context.resume).toBeUndefined();
  expect(h.sessions.at(-1)?.context.fork).toBeUndefined();
  expect(h.inputs.at(-1)?.nativeId).not.toBe(native);
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

test("provider switches into or out of SDK require fresh context instead of reclaiming a checkpoint", async () => {
  for (const direction of ["into", "out"] as const) {
    const h = setup({ cursorBackend: "cursor-sdk", configure: false });
    const id = direction === "out" ? await cursor(h) : await h.create();
    const provider = direction === "out" ? "codex" : "cursor";
    const original = h.store.getThread(id);
    const native = h.inputs.at(-1)?.nativeId;
    expect(h.command({ type: "thread.switch", threadId: id, selection: { provider } }).ok).toBe(
      true,
    );
    await h.engine.flush();
    expect(h.store.getThread(id)?.switch).toMatchObject({
      state: "failed",
      error: expect.stringContaining("source checkpoint is preserved"),
    });
    expect(h.store.getThread(id)?.provider).toBe(original?.provider);
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        delivery: "queue",
        input: [{ type: "text", text: "source continuation" }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.inputs.at(-1)?.nativeId).toBe(native);
  }
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
