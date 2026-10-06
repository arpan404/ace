import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

test("transport fallback diagnostics preserve raw evidence without flooding the conversation", () => {
  const h = setup();
  h.start();
  const line =
    "\u001b[2m2026-10-06T03:33:19Z\u001b[0m \u001b[31mERROR\u001b[0m codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden";
  for (let seq = 50; seq < 60; seq++)
    h.feed({ seq, t: 2, dir: "stderr", channel: "stderr", data: line });
  h.item({ type: "agentMessage", id: "answer", text: "QA_DONE", phase: "final_answer" }, true);
  h.end();
  expect(Object.values(h.state.items).filter((item) => item.type === "notice")).toEqual([]);
  expect(
    h.events.some(
      (event) =>
        event.type === "item.created" &&
        event.item.type === "message" &&
        event.item.role === "assistant",
    ),
  ).toBe(true);
  expect(h.diagnostics.filter((entry) => entry.type === "stderr")).toHaveLength(10);
  expect(h.diagnostics.some((entry) => "data" in entry && entry.data === line)).toBe(true);
});
