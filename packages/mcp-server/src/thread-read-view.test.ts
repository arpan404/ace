import { expect, it } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, agentControlToolkit } from "./index.ts";
import type { AgentControlOperation } from "@ace/protocol";
import { scope } from "./test-support.ts";

const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
const selection = {
  nativeSessionId: "01a1577c-8465-76c1-84bb-cad164cee9da",
  selection: {
    provider: "codex",
    model: "gpt-6.1-sol",
    instanceId: "account-e39484b4-ccae-4be1-94ca-154e1231da27",
    options: { effort: "high" },
  },
};
const base = (id: string) => ({
  id,
  agentId: "01a1577c-8376-744a-be44-e538cb341121",
  runId: "01a1577f-66bf-702a-b4ef-26abffa5ac2b",
  createdAt: 1792469545891,
  nativeId: "03c94ceb-5fb8-4818-aa4f-2daf8a729a1f",
  executionSource: selection,
  complete: true,
});
const nativeFrame = (id: string) => ({
  type: "response_item",
  data: { type: "message", id: `rs_${id}`, content: [{ text: "x".repeat(600) }] },
});
const longAnswer = "The login form posts to /api/session. ".repeat(40);
/** A daemon page shaped like a real one: provenance, native frames and paging bookkeeping. */
const daemonPage = {
  thread: { id: "child", title: "Fix login" },
  threadId: "child",
  metadata: null,
  linkedPrs: [],
  itemsBefore: 1178844,
  itemSeqs: { "item-1": 1178844, "item-2": 1178900, "item-3": 1179000 },
  seq: 1179079,
  items: [
    {
      ...base("item-1"),
      type: "message",
      role: "user",
      synthetic: false,
      parts: [
        {
          type: "text",
          text: "Fix the login form",
          source: { streamId: "text:item-1", bytes: 36, encoding: "utf-16le" },
        },
      ],
      raw: [nativeFrame("1")],
    },
    {
      ...base("item-2"),
      type: "tool_call",
      call: {
        id: "item-2",
        agentId: "01a1577c-8376-744a-be44-e538cb341121",
        kind: "mcp",
        title:
          "Block until threads settle, up to timeoutSeconds. Returns early with needs_you, naming each request, when a thread waits on the person.",
        status: "succeeded",
        detail: { kind: "mcp", server: "ace", tool: "wait", arguments: { threadIds: ["c1"] } },
        result: {
          isError: false,
          content: [{ type: "text", text: '{"ok":true,"data":{"status":"ready"}}' }],
          structuredContent: { ok: true, data: { status: "ready" } },
          durationMs: 3000,
        },
        startedAt: 1792469545891,
        endedAt: 1792469548891,
        raw: [nativeFrame("2"), nativeFrame("3")],
      },
    },
    {
      ...base("item-3"),
      type: "message",
      role: "assistant",
      synthetic: false,
      parts: [
        {
          type: "text",
          text: longAnswer.slice(0, 200),
          source: { streamId: "text:item-3", bytes: longAnswer.length * 2, encoding: "utf-16le" },
        },
      ],
      raw: [nativeFrame("4")],
    },
  ],
};

async function read(page: unknown, input: Record<string, unknown> = { threadId: "child" }) {
  const seen: AgentControlOperation[] = [];
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit({
    async execute(_caller, operation) {
      seen.push(operation);
      return operation.op === "thread.read" ? { ok: true, data: page } : { ok: true, data: [] };
    },
  }).register(registry);
  const lease = new CredentialRegistry(() => "a".repeat(64)).issue(
    scope("root", ["agents"]),
    new AbortController().signal,
  );
  const result = await registry.call(
    "thread_read",
    input,
    lease.principal,
    new AbortController().signal,
  );
  const data = z
    .object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) })
    .parse(result.structuredContent).data;
  return { data, seen, text: JSON.stringify(result.structuredContent) };
}

it("thread_read gives agents the words, tool outcomes and paging ids without native payloads or provenance", async () => {
  const { data, text } = await read(daemonPage);
  expect(text).not.toMatch(
    /"raw"|executionSource|"agentId"|"runId"|"nativeId"|"createdAt"|itemSeqs|"seq"|structuredContent|startedAt|durationMs/,
  );
  expect(data["itemsBefore"]).toBe(1178844);
  expect(data["items"]).toEqual([
    {
      id: "item-1",
      type: "message",
      role: "user",
      parts: [{ type: "text", text: "Fix the login form" }],
    },
    {
      id: "item-2",
      type: "tool_call",
      call: {
        kind: "mcp",
        status: "succeeded",
        detail: { kind: "mcp", server: "ace", tool: "wait", arguments: { threadIds: ["c1"] } },
        result: { content: [{ type: "text", text: '{"ok":true,"data":{"status":"ready"}}' }] },
      },
    },
    {
      id: "item-3",
      type: "message",
      role: "assistant",
      // Cut short in the page: the stream id reads the rest.
      parts: [
        { type: "text", text: longAnswer.slice(0, 200), source: { streamId: "text:item-3" } },
      ],
    },
  ]);
  // This page: about 1,340 tokens as the daemon stores it, about 260 as agents read it.
  expect(tokens(data)).toBeLessThan(tokens(daemonPage) / 4);
});

it("a still-streaming item and a failed tool call keep what an agent acts on", async () => {
  const { data } = await read({
    ...daemonPage,
    items: [
      { ...base("item-4"), type: "reasoning", text: "Thinking", complete: false, raw: [] },
      {
        ...base("item-5"),
        type: "tool_call",
        call: {
          id: "item-5",
          agentId: "a",
          kind: "shell",
          title: "npm test",
          status: "failed",
          error: "exit 1",
          detail: {
            kind: "shell",
            command: "npm test",
            exitCode: 1,
            output: { streamId: "out-5", bytes: 9000, tail: "1 failing", truncated: true },
          },
          startedAt: 1,
          raw: [],
        },
      },
    ],
  });
  expect(data["items"]).toEqual([
    { id: "item-4", type: "reasoning", text: "Thinking", complete: false },
    {
      id: "item-5",
      type: "tool_call",
      call: {
        kind: "shell",
        title: "npm test",
        status: "failed",
        error: "exit 1",
        detail: {
          kind: "shell",
          command: "npm test",
          exitCode: 1,
          output: { streamId: "out-5", bytes: 9000, tail: "1 failing", truncated: true },
        },
      },
    },
  ]);
});

it("a page holds ten items unless the agent asks for more", async () => {
  const { seen } = await read(daemonPage);
  expect(seen).toContainEqual(expect.objectContaining({ op: "thread.read", limit: 10 }));
  const more = await read(daemonPage, { threadId: "child", limit: 30 });
  expect(more.seen).toContainEqual(expect.objectContaining({ op: "thread.read", limit: 30 }));
});
