import { expect, test } from "vitest";
import { spadeBotPermission, stayReadOnly } from "./spade-bot.ts";

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
