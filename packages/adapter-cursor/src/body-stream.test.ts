import { expect, it } from "vitest";
import { streamSdkBody, ShellStreams } from "./index.ts";
import { z } from "zod";
import { replay } from "./translator-test-support.ts";

it("appends explicitly associated live shell deltas before completion and does not append final overlap again", async () => {
  const r = replay(),
    shell = new ShellStreams(),
    emit = async (kind: string, body: unknown) => {
      r.frame(kind, body);
    };
  r.frame("delta", {
    type: "tool-call-started",
    callId: "shell",
    toolCall: { type: "shell", args: { command: "synthetic" } },
  });
  for (const text of ["one ", "two"]) {
    const p = await streamSdkBody(
      { type: "shell-output-delta", event: { callId: "shell", text } },
      "part",
      emit,
      {},
      16777216,
      shell,
      "scope",
    );
    r.frame("delta", p.body);
  }
  expect(Object.values(r.state.items).find((item) => item.type === "tool_call")).toMatchObject({
    complete: false,
    call: { detail: { output: { tail: "one two" } } },
  });
  const p = await streamSdkBody(
    {
      type: "tool-call-completed",
      callId: "shell",
      toolCall: {
        type: "shell",
        result: { status: "success", value: { exitCode: 0, stdout: "one two" } },
      },
    },
    "final",
    emit,
    {},
    16777216,
    shell,
    "scope",
  );
  r.frame("delta", p.body);
  r.frame("result", { status: "finished" });
  expect(Object.values(r.state.items).find((item) => item.type === "tool_call")).toMatchObject({
    complete: true,
    call: { status: "succeeded", detail: { output: { tail: "one two" } } },
  });
});

it("redacts secrets split across raw chunks and preserves unknown large data without invoking getters", async () => {
  const parts: { kind: string; body: unknown }[] = [];
  const secret = "sentinel-environment-secret",
    text = "x".repeat(4090) + secret + "y".repeat(300000);
  const prepared = await streamSdkBody(
    { type: "future", text, apiKey: 123, inputTokens: 12 },
    "raw",
    async (kind, body) => {
      parts.push({ kind, body });
    },
    { env: { CURSOR_API_KEY: secret } },
  );
  expect(prepared.raw?.size).toBeGreaterThan(262144);
  const serialized = JSON.stringify(parts);
  expect(serialized).not.toContain(secret);
  const joined = parts
    .flatMap((part) => {
      const blob = z.object({ text: z.string().optional() }).parse(part.body);
      return blob.text ? [blob.text] : [];
    })
    .join("");
  expect(JSON.parse(joined)).toMatchObject({ apiKey: "<SECRET>", inputTokens: 12 });
  expect(JSON.stringify(prepared.body)).toContain('"apiKey":"<SECRET>"');
  expect(JSON.stringify(prepared.body)).toContain('"inputTokens":12');
  let invoked = false;
  const getter = Object.defineProperty({ type: "future" }, "text", {
    enumerable: true,
    get() {
      invoked = true;
      return text;
    },
  });
  await expect(streamSdkBody(getter, "getter", async () => {}, {})).rejects.toThrow();
  expect(invoked).toBe(false);
});

it("retains a large text delta completely through ordered chunks rather than rendering its preview", async () => {
  const r = replay(),
    text = "text\n".repeat(70000);
  const p = await streamSdkBody(
    { type: "text-delta", text },
    "large-text",
    async (kind, body) => {
      r.frame(kind, body);
    },
    {},
  );
  r.frame("delta", p.body);
  r.frame("result", { status: "finished" });
  const messages = Object.values(r.state.items).filter(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expect(messages).toHaveLength(1);
  const message = messages[0];
  if (!message || message.type !== "message") throw new Error("Missing assistant message");
  expect(message.parts).toEqual([{ type: "text", text }]);
});

it.each(["text-delta", "thinking-delta"])(
  "retains a large child %s completely with child attribution and no duplicate preview",
  async (type) => {
    const r = replay(),
      text = "child 🚀\n".repeat(10000);
    r.frame("delta", {
      type: "tool-call-started",
      callId: "task",
      toolCall: { type: "task", args: { description: "child" } },
    });
    const child = Object.values(r.state.agents).find(
      (record) => record.agent.origin === "provider_subagent",
    );
    if (!child) throw new Error("Missing child");
    const p = await streamSdkBody(
      { type: "tool-call-delta", callId: "task", taskUpdate: { type, text } },
      "large-child",
      async (kind, body) => {
        r.frame(kind, body);
      },
      {},
    );
    r.frame("delta", p.body);
    const messages = Object.values(r.state.items).filter((item) =>
      type === "text-delta"
        ? item.type === "message" && item.role === "assistant"
        : item.type === "reasoning",
    );
    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (!message) throw new Error("Missing child message");
    expect(message).toMatchObject({ agentId: child.agent.id, complete: false });
    if (message.type === "message") expect(message.parts).toEqual([{ type: "text", text }]);
    else expect(message).toMatchObject({ type: "reasoning", text });
    r.frame("delta", {
      type: "tool-call-completed",
      callId: "task",
      toolCall: { type: "task", result: { status: "success", value: { isBackground: false } } },
    });
    expect(r.state.items[message.id]).toMatchObject({ complete: true });
    r.frame("result", { status: "finished" });
    expect(
      Object.values(r.state.items).filter(
        (item) =>
          item.type === "reasoning" || (item.type === "message" && item.role === "assistant"),
      ),
    ).toHaveLength(1);
  },
);

it("retains large surviving child text from an old segment without settling its replacement", async () => {
  const r = replay(),
    text = "surviving child\n".repeat(6000);
  r.frame("delta", {
    type: "tool-call-started",
    callId: "task",
    toolCall: { type: "task", args: {} },
  });
  const child = Object.values(r.state.agents).find(
    (record) => record.agent.origin === "provider_subagent",
  );
  if (!child) throw new Error("Missing child");
  r.frame("cancel", { replacement: true }, { dir: "send" });
  r.frame("result", { status: "cancelled" });
  r.frame("send", { input: [] }, { segment: 1 });
  const p = await streamSdkBody(
    { type: "tool-call-delta", callId: "task", taskUpdate: { type: "text-delta", text } },
    "surviving-child",
    async (kind, body) => {
      r.frame(kind, body, { segment: 0 });
    },
    {},
  );
  r.frame("delta", p.body, { segment: 0 });
  expect(
    Object.values(r.state.items).find(
      (item) => item.type === "message" && item.role === "assistant",
    ),
  ).toMatchObject({ agentId: child.agent.id, complete: false, parts: [{ type: "text", text }] });
  expect(r.state.agents.root?.activeRun).toBeDefined();
});

it("retains large deeper task data as raw evidence without claiming an attributed transcript", async () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "parent",
    toolCall: { type: "task", args: {} },
  });
  r.frame("delta", {
    type: "tool-call-delta",
    callId: "parent",
    taskUpdate: {
      type: "tool-call-started",
      callId: "grandchild",
      toolCall: { type: "task", args: {} },
    },
  });
  const p = await streamSdkBody(
    {
      type: "tool-call-delta",
      callId: "parent",
      taskUpdate: {
        type: "tool-call-delta",
        callId: "grandchild",
        taskUpdate: { type: "text-delta", text: "x".repeat(70000) },
      },
    },
    "deep-child",
    async (kind, body) => {
      r.frame(kind, body);
    },
    {},
  );
  r.frame("delta", p.body);
  expect(p.raw?.size).toBeGreaterThan(70000);
  expect(
    Object.values(r.state.items).filter(
      (item) => item.type === "message" && item.role === "assistant",
    ),
  ).toHaveLength(0);
  expect(
    Object.values(r.state.items).some(
      (item) => item.type === "notice" && item.text.includes("beyond one level"),
    ),
  ).toBe(true);
});
