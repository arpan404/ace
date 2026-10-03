import { afterEach, expect, test } from "vitest";
import { ToolRegistry } from "@ace/mcp-server";
import { HandoffChunk, HandoffPage, McpScope, ThreadId } from "@ace/protocol";
import { handoffToolkit } from "../services/handoff-tools.ts";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test("a fork pages its cutoff history and reads full text after portable delivery", async () => {
  const h = transitionHarness();
  cleanup.push(h.close);
  const source = await h.create();
  const full = "Long source text 🦊 ".repeat(600);
  h.command({
    type: "thread.send",
    threadId: source,
    input: [{ type: "text", text: full }],
    delivery: "queue",
  });
  await h.engine.flush();
  const point = h.finishedRun(source);
  h.command({
    type: "thread.send",
    threadId: source,
    input: [{ type: "text", text: "later private secret" }],
    delivery: "queue",
  });
  await h.engine.flush();
  const fork = await h.fork(source, { type: "turn", runId: point.id });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  handoffToolkit(h.store).register(registry);
  const principal = {
    scope: McpScope.parse({
      sessionId: "caller",
      threadId: fork,
      agentId: h.store.getThread(fork)?.rootAgentId,
      capabilities: [],
    }),
    signal: new AbortController().signal,
  };
  const call = (name: string, args: unknown) =>
    registry.call(name, args, principal, principal.signal);
  const response = await call("ace_read_handoff", {
    sourceThreadId: source,
    before: h.store.headSeq() + 1,
    limit: 1,
  });
  const page = HandoffPage.parse(response.structuredContent);
  const item = page.items[0];
  if (item?.type !== "message") throw new Error("Expected source conversation");
  const part = item.parts[0];
  if (part?.type !== "text" || !part.source) throw new Error("Expected full text pointer");
  expect(part.text).not.toContain("later private secret");
  expect(part.text.length).toBeLessThan(full.length);
  let offset = 0;
  const chunks: Buffer[] = [];
  for (let index = 0; index < 32; index++) {
    const result = await call("ace_read_handoff_chunk", {
      sourceThreadId: source,
      streamId: part.source.streamId,
      offset,
      limit: 1024,
    });
    const chunk = HandoffChunk.parse(result.structuredContent);
    expect(chunk.encoding).toBe("utf-16le");
    chunks.push(Buffer.from(chunk.bytes, "base64"));
    offset = chunk.nextOffset;
    if (chunk.eof) break;
  }
  expect(Buffer.concat(chunks).toString("utf16le")).toContain(full);
  expect(page.itemsBefore).not.toBeNull();
  expect(
    await call("ace_read_handoff", { sourceThreadId: source, before: page.itemsBefore }),
  ).toMatchObject({ structuredContent: { threadId: source } });
  expect(
    await call("ace_read_handoff", { sourceThreadId: ThreadId.parse("unrelated") }),
  ).toMatchObject({ isError: true });

  const latest = h.store.readItemPage(source, h.store.headSeq() + 1, 1).items[0];
  const laterPart = latest?.type === "message" ? latest.parts[0] : undefined;
  if (laterPart?.type !== "text" || !laterPart.source)
    throw new Error("Expected later source stream");
  expect(
    await call("ace_read_handoff_chunk", {
      sourceThreadId: source,
      streamId: laterPart.source.streamId,
    }),
  ).toMatchObject({ isError: true });
});
