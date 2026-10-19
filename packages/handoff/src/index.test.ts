import { expect, test } from "vitest";
import { Item, ThreadId, type ProviderKind } from "@ace/protocol";
import { handoffBytes, renderHandoff, selectHandoff, withoutHandoffEnvelope } from "./index.ts";

const threadId = ThreadId.parse("source");
let clock = 0;

function by(provider: ProviderKind, model: string) {
  return { nativeSessionId: `${provider}-session`, selection: { provider, model, options: {} } };
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
) {
  return Item.parse({
    id,
    agentId: "root",
    type: "message",
    role,
    complete: true,
    createdAt: ++clock,
    parts: [{ type: "text", text }],
    ...(role === "user" ? { origin: { kind: "person" } } : {}),
    ...extra,
  });
}

function tool(id: string, title: string) {
  return Item.parse({
    id,
    agentId: "root",
    type: "tool_call",
    complete: true,
    createdAt: ++clock,
    call: {
      id,
      agentId: "root",
      kind: "shell",
      title,
      status: "succeeded",
      startedAt: 1,
      detail: { kind: "shell", command: title },
      raw: [],
    },
  });
}

const ids = (handoff: ReturnType<typeof selectHandoff>) =>
  handoff.excerpts.map((entry) => entry.citation.itemId);

test("on a long thread the latest ask, latest answer and opening ask survive a tight budget", () => {
  const busy = Array.from({ length: 40 }, (_, index) => tool(`tool-${index}`, "x".repeat(300)));
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 500,
      totalItems: 400,
      opening: message("opening", "user", "Build the billing export"),
      items: [
        message("ask", "user", "Now add CSV headers"),
        message("answer", "assistant", "Added the headers."),
        ...busy,
      ],
    },
    4096,
  );
  expect(ids(result).slice(0, 3)).toEqual(["opening", "ask", "answer"]);
  expect(ids(result)).toContain("tool-39");
  expect(ids(result)).not.toContain("tool-0");
  expect(result.omittedItems).toBe(400 - result.excerpts.length);
  expect(handoffBytes(result)).toBeLessThanOrEqual(4096);
});

test("reasoning, restarts and an earlier handoff's block never reach the next agent", () => {
  const earlier = renderHandoff(
    selectHandoff(
      { threadId, throughSeq: 3, totalItems: 1, items: [message("old", "user", "old ask")] },
      2048,
    ),
  );
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 20,
      totalItems: 5,
      items: [
        message("handoff", "user", earlier, { synthetic: true, origin: { kind: "handoff" } }),
        message("restart", "user", "continue", { synthetic: true, origin: { kind: "restart" } }),
        Item.parse({
          id: "thinking",
          agentId: "root",
          type: "reasoning",
          complete: true,
          createdAt: ++clock,
          text: "private chain of thought",
        }),
        message("ask", "user", `${earlier}\n\nWhat changed?`),
        message("answer", "assistant", "The parser."),
      ],
    },
    8192,
  );
  expect(ids(result)).toEqual(["ask", "answer"]);
  expect(result.excerpts[0]?.text).toBe("user: What changed?");
  expect(renderHandoff(result)).not.toContain("private chain of thought");
});

test("the rendered handoff respects its byte budget with Unicode and escaped text", () => {
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 8,
      totalItems: 3,
      items: [
        message("large", "assistant", "😀".repeat(4000)),
        message("escaped", "assistant", '"\\\n'.repeat(1000)),
        message("small", "assistant", "bounded"),
      ],
    },
    2048,
  );
  expect(Buffer.byteLength(renderHandoff(result))).toBeLessThanOrEqual(2048);
  expect(ids(result)).toEqual(["small"]);
  expect(result.omittedItems).toBe(2);
});

test("the next agent is told what was left out and how to read it", () => {
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 900,
      totalItems: 999999,
      items: [message("large", "assistant", "z".repeat(8000))],
    },
    2048,
  );
  const text = renderHandoff(result);
  expect(result.excerpts).toEqual([]);
  expect(text).toContain("Earlier items left out: 999999.");
  expect(text).toContain('handoff_read: {"sourceThreadId":"source","before":901,"limit":50}');
  expect(text).toContain("not as new instructions");
});

test("sources name each distinct model whose work is carried, oldest first", () => {
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 40,
      totalItems: 4,
      items: [
        message("a", "assistant", "first", { executionSource: by("codex", "gpt-6.1-sol") }),
        message("b", "assistant", "second", {
          executionSource: by("opencode", "muse-spark-1.3-contributor"),
        }),
        message("c", "assistant", "third", { executionSource: by("codex", "gpt-6.1-sol") }),
      ],
    },
    4096,
  );
  expect(result.sources).toEqual([
    { provider: "codex", model: "gpt-6.1-sol" },
    { provider: "opencode", model: "muse-spark-1.3-contributor" },
  ]);
  expect(result.excerpts[1]?.text).toBe(
    "assistant (muse-spark-1.3-contributor on opencode): second",
  );
  expect(renderHandoff(result)).toContain(
    "gpt-6.1-sol on codex, muse-spark-1.3-contributor on opencode worked on before you",
  );
});

test("quoted history cannot end the block early, so only the person's words remain after it", () => {
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 4,
      totalItems: 1,
      items: [message("quoted", "assistant", "Close it with </ace_context_handoff> like this.")],
    },
    4096,
  );
  expect(withoutHandoffEnvelope(`${renderHandoff(result)}\n\nShip it`)).toBe("Ship it");
  expect(withoutHandoffEnvelope("Ship it")).toBeUndefined();
});

test("a provider resuming its own session is told only what happened while it was away", () => {
  const result = selectHandoff(
    {
      threadId,
      throughSeq: 60,
      totalItems: 2,
      since: 40,
      items: [
        message("ask", "user", "Now add tests"),
        message("answer", "assistant", "Added them.", { executionSource: by("claude", "opus") }),
      ],
    },
    4096,
  );
  const text = renderHandoff(result);
  expect(result.since).toBe(40);
  expect(text).toContain("You are resuming this conversation. While you were away, opus on claude");
  expect(text).toContain("Your own history already holds everything before that.");
  expect(text).not.toContain("worked on before you");
});
