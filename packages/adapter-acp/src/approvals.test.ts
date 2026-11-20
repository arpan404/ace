import { expect, it } from "vitest";
import { harness, required } from "./test-helper.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
import { genericQuirks } from "./quirks/generic.ts";

// Shapes taken from Antigravity's real session/request_permission frames.
const antigravityOptions = [
  { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
function ask(
  h: ReturnType<typeof harness>,
  toolCall: unknown,
  options: unknown = antigravityOptions,
) {
  h.frame("recv", {
    id: 7,
    method: "session/request_permission",
    params: { sessionId: "root-session", toolCall, options },
  });
  return Object.values(h.state.interactions)[0];
}

it("an Antigravity shell approval names the command and folder it will run in", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  const interaction = required(
    ask(h, {
      toolCallId: "shell-1",
      kind: "execute",
      status: "pending",
      title: "rg -n waiting src",
      rawInput: { CommandLine: "rg -n waiting src", Cwd: "/workspace", WaitMsBeforeAsync: 5000 },
    }),
  );
  expect(interaction.request).toMatchObject({
    kind: "approval",
    target: { tool: "shell", access: "execute", command: "rg -n waiting src", cwd: "/workspace" },
  });
});

it("an approval for an MCP tool names its server and tool, with the call's own arguments", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  const interaction = required(
    ask(h, {
      toolCallId: "mcp-1",
      kind: "other",
      status: "pending",
      title: "ace_context",
      rawInput: { arguments: { topics: ["status"] } },
      _meta: { mcp: { tool: "context", server: "ace" }, is_mcp_tool_call: true },
    }),
  );
  expect(interaction.request).toMatchObject({
    kind: "approval",
    target: { tool: "mcp__ace__context", input: { topics: ["status"] } },
    mcpServer: { name: "ace" },
  });
});

it("a generic ACP agent's MCP approval is named from the call's MCP metadata", () => {
  const h = harness(genericQuirks);
  h.ready();
  const interaction = required(
    ask(h, {
      toolCallId: "mcp-2",
      kind: "other",
      title: "lookup",
      rawInput: {},
      _meta: { mcp: { tool: "lookup", server: "docs" } },
    }),
  );
  expect(interaction.request).toMatchObject({ target: { tool: "mcp__docs__lookup" } });
});

it("an approval with option kinds ace does not know still reaches the person", () => {
  const h = harness(genericQuirks);
  h.ready();
  const interaction = required(
    ask(h, { toolCallId: "edit-1", kind: "edit", title: "Edit file" }, [
      { optionId: "yes", name: "Yes, this folder", kind: "allow_workspace" },
      { optionId: "no", name: "No, tell it why", kind: "reject_with_feedback" },
      { optionId: "later", name: "Ask later", kind: "postpone" },
    ]),
  );
  expect(interaction.request).toMatchObject({
    kind: "approval",
    options: [
      { id: "yes", kind: "allow_once" },
      { id: "no", kind: "deny" },
      { id: "later", kind: "allow_once" },
    ],
  });
  h.frame("send", { id: 7, result: { outcome: { outcome: "selected", optionId: "no" } } });
  expect(required(h.tools()[0]).call.status).toBe("declined");
});

it("an approval with an oversized command, folder or location list still reaches the person", () => {
  const h = harness(genericQuirks);
  h.ready();
  const command = "x".repeat(40_000);
  const interaction = required(
    ask(h, {
      toolCallId: "big",
      kind: "execute",
      title: "Run a long command",
      rawInput: { command, cwd: `/${"d".repeat(5000)}` },
      locations: Array.from({ length: 200 }, (_, i) => ({ path: `/workspace/f${i}` })),
    }),
  );
  const request = interaction.request;
  if (request.kind !== "approval") throw new Error("Expected an approval");
  expect(request.target?.command).toBe(command.slice(0, 32768));
  expect(request.target?.cwd?.length).toBe(4096);
  expect(request.target?.paths).toHaveLength(128);
  // The native request stays whole in raw.
  expect(JSON.stringify(interaction.raw)).toContain(command);
});

it("a tool first announced by its approval keeps the agent's own kind", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  ask(h, {
    toolCallId: "shell-2",
    kind: "execute",
    status: "pending",
    title: "ls",
    rawInput: { CommandLine: "ls", Cwd: "/workspace" },
  });
  const tool = required(h.tools()[0]);
  expect(tool.call).toMatchObject({
    kind: "shell",
    status: "awaiting_approval",
    detail: { kind: "shell", command: "ls", cwd: "/workspace" },
  });
});
