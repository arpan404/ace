import { expect, it } from "vitest";
import { replay } from "./translator-test-support.ts";

it("ace MCP failures show their real error text while other Cursor errors keep the fallback", () => {
  const h = replay();
  for (const [id, server] of [
    ["ace", "ace"],
    ["other", "other"],
  ]) {
    h.frame("delta", {
      type: "tool-call-started",
      callId: id,
      toolCall: { type: "mcp", args: { server, tool: "screen_click", arguments: { x: 1, y: 2 } } },
    });
    h.frame("delta", {
      type: "tool-call-completed",
      callId: id,
      toolCall: {
        type: "mcp",
        result: {
          status: "success",
          value: { isError: true, content: [{ type: "text", text: "Text destination changed" }] },
        },
      },
    });
  }
  const calls = Object.values(h.state.items).flatMap((item) =>
    item.type === "tool_call" ? [item.call] : [],
  );
  expect(
    calls.find((call) => call.detail.kind === "mcp" && call.detail.server === "ace"),
  ).toMatchObject({ status: "failed", error: "Text destination changed" });
  expect(
    calls.find((call) => call.detail.kind === "mcp" && call.detail.server === "other"),
  ).toMatchObject({
    status: "failed",
    error: "Cursor tool failed or was denied by execution policy",
  });
});
