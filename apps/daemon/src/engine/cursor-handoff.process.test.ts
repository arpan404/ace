import { afterEach, expect, test } from "vitest";
import { ToolRegistry } from "@ace/mcp-server";
import { HandoffChunk, HandoffPage, McpScope, PortableHandoff } from "@ace/protocol";
import { handoffToolkit } from "../services/handoff-tools.ts";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test("Cursor portable forks deliver the shared manifest and retain scoped history at the selected turn", async () => {
  const h = transitionHarness();
  cleanup.push(h.close);
  const text = "Cursor history 🦊 ".repeat(600);
  expect(
    h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "cursor",
      input: [{ type: "text", text }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const source = h.store.listThreads()[0]?.id;
  if (!source) throw new Error("Missing Cursor thread");
  const run = h.finishedRun(source);
  const cutoff = h.store
    .readEvents({ afterSeq: 0, threadId: source, limit: 100 })
    .find((event) => event.payload.type === "run.ended" && event.payload.runId === run.id)?.seq;
  if (!cutoff) throw new Error("Missing selected run boundary");
  expect(
    h.command({
      type: "thread.send",
      threadId: source,
      input: [{ type: "text", text: "later Cursor secret" }],
      delivery: "queue",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const fork = await h.fork(source, { type: "turn", runId: run.id });
  const delivered = h.inputs.at(-1);
  expect(delivered?.provider).toBe("cursor");
  const input = delivered?.text ?? "";
  const manifest = PortableHandoff.parse(
    JSON.parse(input.slice(0, input.indexOf("\ncontinue fork"))),
  );
  expect(manifest.origin).toEqual({ provider: "cursor" });
  expect(manifest.throughSeq).toBe(cutoff);
  expect(manifest.history.before).toBe(cutoff + 1);
  expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThanOrEqual(4096);
  expect(input).not.toContain("later Cursor secret");
  expect(h.store.getThread(fork)?.lineage).toMatchObject({ mode: "portable", lossy: true });

  await h.restart();
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  handoffToolkit(h.store).register(registry);
  const principal = {
    scope: McpScope.parse({
      sessionId: "cursor-fork",
      threadId: fork,
      agentId: h.store.getThread(fork)?.rootAgentId,
      capabilities: [],
    }),
    signal: new AbortController().signal,
  };
  const response = await registry.call(
    manifest.history.tool,
    { sourceThreadId: source, before: h.store.headSeq() + 1, limit: 1 },
    principal,
    principal.signal,
  );
  const page = HandoffPage.parse(response.structuredContent);
  const item = page.items[0];
  if (item?.type !== "message" || item.parts[0]?.type !== "text" || !item.parts[0].source)
    throw new Error("Missing Cursor full history pointer");
  expect(item.parts[0].text).not.toContain("later Cursor secret");
  const responseChunk = await registry.call(
    manifest.history.chunkTool,
    { sourceThreadId: source, streamId: item.parts[0].source.streamId, offset: 0, limit: 65536 },
    principal,
    principal.signal,
  );
  const chunk = HandoffChunk.parse(responseChunk.structuredContent);
  expect(Buffer.from(chunk.bytes, "base64").toString("utf16le")).toContain(text);
  expect(chunk.eof).toBe(true);
  expect(
    await registry.call(
      manifest.history.tool,
      { sourceThreadId: "unrelated" },
      principal,
      principal.signal,
    ),
  ).toMatchObject({ isError: true });
});
