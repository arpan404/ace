import { expect, test } from "vitest";
import { setup, shell } from "./translator.test-helper.ts";
const resume = (h: ReturnType<typeof setup>, turns: unknown[]) => {
  h.send("thread/resume", { threadId: "native" });
  h.feed({
    seq: 99,
    t: 100,
    dir: "recv",
    channel: "stdio",
    data: { id: 90, result: { thread: { id: "native", status: { type: "idle" }, turns } } },
  });
};
test("hydration preserves historical messages and surviving shell tasks before ending the turn", () => {
  const h = setup();
  resume(h, [
    {
      id: "old",
      status: "completed",
      items: [{ id: "message", type: "agentMessage", text: "history" }, shell],
    },
  ]);
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  expect(
    Object.values(h.state.items).some(
      (i) => i.type === "message" && i.parts.some((p) => p.type === "text" && p.text === "history"),
    ),
  ).toBe(true);
});
test("started aggregate and streamed suffix appear exactly once and late output preserves completion", () => {
  const h = setup();
  h.start();
  h.item({ ...shell, aggregatedOutput: "prefix" });
  h.recv("item/commandExecution/outputDelta", {
    threadId: "native",
    itemId: "exec",
    delta: "suffix",
  });
  h.item({ ...shell, status: "completed", aggregatedOutput: "prefixsuffix" }, true);
  h.end();
  h.recv("item/commandExecution/outputDelta", {
    threadId: "native",
    itemId: "exec",
    delta: "late",
  });
  const call = Object.values(h.state.items).find(
    (i) => i.type === "tool_call" && i.call.kind === "shell",
  );
  expect(call?.complete).toBe(true);
  expect(
    call?.type === "tool_call" &&
      call.call.detail.kind === "shell" &&
      call.call.detail.output?.tail,
  ).toBe("prefixsuffixlate");
  expect(h.state.status.state).toBe("done");
});
test("unknown human flags block immediately and keep blocking after turn completion", () => {
  const h = setup();
  h.start();
  h.recv("thread/status/changed", {
    threadId: "native",
    status: { type: "active", activeFlags: ["futureApproval"] },
  });
  expect(h.state.status.state).toBe("needs_you");
  h.end();
  expect(h.state.status.state).toBe("needs_you");
});
test.each([
  { id: "vendor", type: "subAgentActivity", kind: "vendor" },
  { id: "invalid", type: "subAgentActivity", kind: "started" },
])("unsupported subagent activity retains raw data: $id", (item) => {
  const h = setup();
  h.start();
  h.item(item, true);
  expect(
    Object.values(h.state.items).some(
      (i) =>
        i.type === "notice" &&
        i.raw.some(
          (r) => ("data" in r ? JSON.stringify(r.data) : undefined) === JSON.stringify(item),
        ),
    ),
  ).toBe(true);
});
test.each([null, [], "bad", 42])("malformed primitive retains its raw value: %j", (data) => {
  const h = setup();
  h.feed({ seq: 99, t: 100, dir: "recv", channel: "stdio", data });
  expect(
    Object.values(h.state.items).some(
      (i) =>
        i.type === "notice" &&
        i.raw.some(
          (r) => ("data" in r ? JSON.stringify(r.data) : undefined) === JSON.stringify(data),
        ),
    ),
  ).toBe(true);
});
test("user image content preserves its original URL", () => {
  const h = setup();
  h.item(
    {
      id: "image",
      type: "userMessage",
      content: [{ type: "image", url: "https://example.test/image.png" }],
    },
    true,
  );
  const message = Object.values(h.state.items).find((i) => i.type === "message");
  expect(message?.type === "message" && message.parts).toEqual([
    { type: "image", mimeType: "image/*", url: "https://example.test/image.png" },
  ]);
});
test("native usage updates publish token counts", () => {
  const h = setup();
  h.start();
  h.recv("thread/tokenUsage/updated", {
    threadId: "native",
    tokenUsage: { last: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 } },
  });
  expect(
    h.events.some(
      (e) =>
        e.type === "usage.updated" &&
        e.inputTokens === 11 &&
        e.outputTokens === 7 &&
        e.cachedInputTokens === 3,
    ),
  ).toBe(true);
});
