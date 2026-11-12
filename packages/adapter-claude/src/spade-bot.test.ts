import { expect, test } from "vitest";
import { refusedPlanMessage, spadeBotPermission, stayReadOnly } from "./spade-bot.ts";
import { harness } from "./translator.test-helper.ts";

const allow = ["spade_tools", "spade_call", "context"];

test("a Spade bot's session runs the gated bridge and ace's reads without a prompt, and never leaves plan mode", () => {
  const input = { tool: "note_down", arguments: {} };
  expect(spadeBotPermission(allow, "mcp__ace__spade_call", input)).toEqual({
    behavior: "allow",
    updatedInput: input,
  });
  // Through ace's dispatcher too.
  const dispatched = { name: "spade_tools", arguments: {} };
  expect(spadeBotPermission(allow, "mcp__ace__tools_call", dispatched)).toEqual({
    behavior: "allow",
    updatedInput: dispatched,
  });
  expect(spadeBotPermission(allow, "ExitPlanMode", {})).toEqual({
    behavior: "deny",
    message: stayReadOnly,
  });
  // Anything else goes to the usual check.
  expect(spadeBotPermission(allow, "mcp__ace__delegate", {})).toBeUndefined();
  expect(spadeBotPermission(allow, "Bash", { command: "rm -rf ." })).toBeUndefined();
});

test("a refused plan reaches the person as the bot's reply text", () => {
  const h = harness();
  h.init();
  const plan = refusedPlanMessage(
    "ExitPlanMode",
    { plan: "1. Read notes.md\n2. Tidy the headings" },
    "req-1",
  );
  if (!plan) throw new Error("no plan message");
  h.send(plan);
  const replies = h.items().filter((item) => item.type === "message" && item.role === "assistant");
  expect(replies).toEqual([
    expect.objectContaining({
      parts: [{ type: "text", text: "1. Read notes.md\n2. Tidy the headings" }],
    }),
  ]);
  // Nothing to deliver from any other tool, or an empty plan.
  expect(refusedPlanMessage("Bash", { command: "ls" }, "req-2")).toBeUndefined();
  expect(refusedPlanMessage("ExitPlanMode", { plan: "  " }, "req-3")).toBeUndefined();
});
