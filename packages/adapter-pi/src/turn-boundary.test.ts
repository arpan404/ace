import { expect, test } from "vitest";
import { replay } from "./testing/harness.ts";

const boundary = (entryId: string) => ({
  type: "extension_ui_request",
  method: "notify",
  message: JSON.stringify({ type: "ace_turn_boundary", entryId }),
  notifyType: "info",
});
test("rewind points bind to the completed answer after tool results without losing its text", () => {
  const h = replay();
  h.recv({ type: "agent_start" });
  h.recv({ type: "turn_start" });
  h.recv({ type: "message_start", message: { role: "assistant" } });
  h.recv({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
  });
  h.recv({ type: "message_start", message: { role: "toolResult" } });
  h.recv({ type: "message_end", message: { role: "toolResult", content: [] } });
  h.recv(boundary("first-leaf"));
  h.recv({ type: "turn_start" });
  h.recv(boundary("stale-leaf"));
  h.recv({ type: "message_start", message: { role: "assistant" } });
  h.recv({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
  });
  h.recv(boundary("second-leaf"));
  h.recv({ type: "agent_settled" });
  const answers = Object.values(h.state.items).filter((item) => item.type === "message");
  expect(answers).toEqual([
    expect.objectContaining({
      nativeId: "first-leaf",
      parts: [{ type: "text", text: "First answer" }],
    }),
    expect.objectContaining({
      nativeId: "second-leaf",
      parts: [{ type: "text", text: "Second answer" }],
    }),
  ]);
  expect(h.state.status.state).toBe("done");
});
