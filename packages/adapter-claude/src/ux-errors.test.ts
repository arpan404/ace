import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";
test("an unrecognised model emits one readable error and retains provider details", () => {
  const h = harness();
  h.init();
  const text = '[claude-code:unrecognized_model] {"model":"opus-5.5","message":"unknown model"}';
  h.send({
    type: "assistant",
    error: "unrecognized_model",
    message: { id: "failure", content: [{ type: "text", text }] },
  });
  h.result();
  expect(h.items()).toHaveLength(1);
  expect(h.items()[0]).toMatchObject({
    type: "notice",
    code: "model_not_found",
    title: 'Claude Code doesn\'t recognise the model "opus-5.5"',
    detail: text,
    raw: [{ data: expect.objectContaining({ error: "unrecognized_model" }) }],
  });
  expect(h.state.agents["root"]?.agent.status).toMatchObject({
    state: "failed",
    error: { code: "model_not_found", detail: text },
  });
});
test("Claude summary titles remain available for daemon title adoption", () => {
  const h = harness();
  h.send({ type: "summary", summary: "Fix redirect handling" });
  expect(h.items()[0]).toMatchObject({
    type: "notice",
    code: "thread_title",
    title: "Fix redirect handling",
  });
});
