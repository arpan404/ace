import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";
import { capabilities } from "./capabilities.ts";

test("CLI stderr remains diagnostic evidence without warning bubbles", () => {
  const h = harness();
  h.init();
  const line = '\u001b[31mAPI Error: 529 {"request_id":"req_private","type":"error"}\u001b[0m';
  h.send(line, "sdk", "stderr");
  h.result();
  expect(h.items().filter((item) => item.type === "notice")).toEqual([]);
  expect(h.rawPayloads().some((raw) => "data" in raw && raw.data === line)).toBe(true);
});
test.each([
  [
    "overloaded_error",
    'API Error: 529 {"request_id":"req_private"}',
    "Claude is busy. Try again shortly.",
  ],
  [
    "server_error",
    'API Error: 500 {"request_id":"req_private"}',
    "Claude had a server error. Try again shortly.",
  ],
  [
    "max_output_tokens",
    '{"request_id":"req_private"}',
    "Claude reached its response limit. Ask it to continue.",
  ],
])("Claude %s errors show plain language and preserve diagnostic detail", (code, text, title) => {
  const h = harness();
  h.init();
  h.send({
    type: "assistant",
    error: code,
    message: { id: "failed", content: [{ type: "text", text }] },
  });
  h.result({ is_error: true });
  expect(h.state.agents["root"]?.agent.status).toMatchObject({
    state: "failed",
    error: { message: title, detail: text },
  });
  expect(h.items()).toContainEqual(
    expect.objectContaining({ type: "notice", text: title, detail: text }),
  );
});
test("overage permits work and a native accepted run clears an older rate block", () => {
  const h = harness();
  h.init();
  h.result();
  h.send({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 123 },
  });
  expect(h.state.status).toMatchObject({ state: "limited", until: 123000 });
  h.send({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", isUsingOverage: true },
  });
  expect(h.state.status.state).not.toBe("limited");
  h.send({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
  });
  h.send({ type: "stream_event", event: { type: "message_start", message: { id: "live" } } });
  expect(h.state.status.state).not.toBe("limited");
  h.send({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
  });
  h.init();
  h.result();
  expect(h.state.status.state).toBe("done");
});
test("a prerelease Claude CLI above the supported baseline can resume and control tasks", () => {
  expect(
    capabilities({ installed: true, auth: "unknown", loginHint: "", version: "2.2.0-beta.1" }),
  ).toMatchObject({ resume: true, backgroundTaskControl: true });
});
