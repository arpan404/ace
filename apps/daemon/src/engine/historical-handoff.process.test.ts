import { afterEach, expect, test } from "vitest";
import { ToolRegistry } from "@ace/mcp-server";
import { HandoffChunk, HandoffPage, McpScope, type ThreadId } from "@ace/protocol";
import { handoffToolkit } from "../services/handoff-tools.ts";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function caller(h: ReturnType<typeof transitionHarness>, fork: ThreadId) {
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
  return (name: string, args: unknown) => registry.call(name, args, principal, principal.signal);
}
async function sourceWithShell() {
  const h = transitionHarness();
  cleanup.push(h.close);
  const source = await h.create();
  h.held.add(source);
  h.command({
    type: "thread.send",
    threadId: source,
    input: [{ type: "text", text: "launch build before cutoff" }],
    delivery: "queue",
  });
  await h.engine.flush();
  h.emit(
    source,
    {
      type: "item.upsert",
      agent: "root",
      item: "build",
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          title: "Build before cutoff",
          status: "running",
          detail: { kind: "shell", command: "build", output: "before cutoff\n" },
        },
      },
    },
    {
      type: "background.started",
      agent: "root",
      task: "build",
      kind: "shell",
      title: "Build",
      stoppable: true,
    },
    { type: "turn.ended", agent: "root", outcome: "completed" },
  );
  await h.engine.flush();
  return { h, source, point: h.finishedRun(source) };
}
function appendFuture(h: ReturnType<typeof transitionHarness>, source: ThreadId, turn: string) {
  h.emit(
    source,
    {
      type: "item.delta",
      agent: "root",
      item: "build",
      field: "output",
      append: "future shell secret\n",
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "build",
      draft: {
        type: "tool_call",
        complete: true,
        call: { title: "Future revised build", status: "succeeded" },
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: turn,
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "future message secret" }],
      },
    },
    { type: "background.ended", task: "build", status: "completed" },
  );
}

test("a granted historical stream and preview remain frozen when the source appends or replaces them", async () => {
  const { h, source, point } = await sourceWithShell();
  const fork = await h.fork(source, { type: "turn", runId: point.id });
  const call = caller(h, fork);
  const initial = HandoffPage.parse(
    (await call("ace_read_handoff", { sourceThreadId: source })).structuredContent,
  );
  const shell = initial.items.find((item) => item.type === "tool_call");
  if (
    shell?.type !== "tool_call" ||
    shell.call.detail.kind !== "shell" ||
    !shell.call.detail.output
  )
    throw new Error("Missing shell stream");
  const streamId = shell.call.detail.output.streamId;
  if (!point.nativeId) throw new Error("Missing source turn identity");
  appendFuture(h, source, point.nativeId);
  await h.engine.flush();
  const page = HandoffPage.parse(
    (await call("ace_read_handoff", { sourceThreadId: source })).structuredContent,
  );
  expect(JSON.stringify(page)).not.toContain("future shell secret");
  expect(JSON.stringify(page)).not.toContain("future message secret");
  expect(JSON.stringify(page)).not.toContain("Future revised build");
  const chunk = HandoffChunk.parse(
    (await call("ace_read_handoff_chunk", { sourceThreadId: source, streamId })).structuredContent,
  );
  expect(Buffer.from(chunk.bytes, "base64").toString("utf8")).toBe("before cutoff\n");
  expect(chunk.eof).toBe(true);
  const beyond = HandoffChunk.parse(
    (
      await call("ace_read_handoff_chunk", {
        sourceThreadId: source,
        streamId,
        offset: chunk.nextOffset,
      })
    ).structuredContent,
  );
  expect(beyond.bytes).toBe("");
  expect(beyond.eof).toBe(true);
});

test("an older fork created after later source updates receives the original conversation revision", async () => {
  const { h, source, point } = await sourceWithShell();
  if (!point.nativeId) throw new Error("Missing source turn identity");
  appendFuture(h, source, point.nativeId);
  await h.engine.flush();
  const fork = await h.fork(source, { type: "turn", runId: point.id });
  expect(h.inputs.at(-1)?.text).toContain("launch build before cutoff");
  expect(h.inputs.at(-1)?.text).not.toContain("future message secret");
  await h.restart();
  const page = HandoffPage.parse(
    (await caller(h, fork)("ace_read_handoff", { sourceThreadId: source })).structuredContent,
  );
  expect(JSON.stringify(page)).toContain("launch build before cutoff");
  expect(JSON.stringify(page)).not.toContain("future message secret");
});

test("an item fork includes the item's completed revision rather than its initial streaming draft", async () => {
  const h = transitionHarness();
  cleanup.push(h.close);
  const source = await h.create();
  h.held.add(source);
  h.command({
    type: "thread.send",
    threadId: source,
    input: [{ type: "text", text: "stream an item" }],
    delivery: "queue",
  });
  await h.engine.flush();
  h.emit(
    source,
    {
      type: "item.upsert",
      agent: "root",
      item: "streamed",
      draft: {
        type: "message",
        role: "assistant",
        complete: false,
        parts: [{ type: "text", text: "initial draft" }],
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "streamed",
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "finished selected content" }],
      },
    },
    { type: "turn.ended", agent: "root", outcome: "completed" },
  );
  await h.engine.flush();
  const item = h.store.readItemPage(source, h.store.headSeq() + 1, 1).items[0];
  if (!item) throw new Error("No streamed item");
  const fork = await h.fork(source, { type: "item", itemId: item.id });
  expect(h.inputs.at(-1)?.text).toContain("finished selected content");
  expect(h.inputs.at(-1)?.text).not.toContain("initial draft");
  const page = HandoffPage.parse(
    (await caller(h, fork)("ace_read_handoff", { sourceThreadId: source })).structuredContent,
  );
  expect(page.items.at(-1)).toMatchObject({
    complete: true,
    parts: [{ type: "text", text: "finished selected content" }],
  });
});
