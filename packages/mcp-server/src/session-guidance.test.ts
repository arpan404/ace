import { expect, it } from "vitest";
import { ProviderKind } from "@ace/protocol";
import { acpInjection, acpToolListing, aceInstructions, developerInstructions } from "./index.ts";

const connection = { url: "http://127.0.0.1:12345/mcp", bearer: "a".repeat(64) };

it("each session hears how to reach thread_start in the way its tool list allows", () => {
  // The shared text names thread_start; only the deferring and Codex sessions list it upfront.
  expect(aceInstructions).toContain("thread_start");
  expect(developerInstructions("claude")).toContain("select:mcp__ace__thread_start");
  expect(developerInstructions("codex")).toContain("tools.mcp__ace__<name>(args)");
  for (const provider of ["opencode", "pi"] as const) {
    const text = developerInstructions(provider);
    expect(text, provider).toContain("come with ace-threads");
    expect(text, provider).toContain("tools_call {name, arguments}");
  }
  for (const provider of ["cursor", "acp"] as const)
    expect(developerInstructions(provider), provider).toContain(
      "such as thread_start or thread_control, with tools_call",
    );
  // Antigravity reaches a deferred tool through its own call_mcp_tool, never Claude's search.
  const antigravity = developerInstructions("antigravity");
  expect(antigravity).toContain('call_mcp_tool (ServerName "ace", ToolName, Arguments)');
  expect(antigravity).toContain("thread_start");
  expect(antigravity).not.toContain("select:mcp__ace__");
});

const guidance = (cli: string) =>
  acpInjection({ ...connection, listing: acpToolListing(cli) }).developerInstructions;

it("an ACP agent's guidance follows the listing its tool refresh supports", () => {
  expect(guidance("gemini")).toContain("come with ace-threads");
  expect(guidance("claude-acp")).toContain("select:mcp__ace__thread_start");
  expect(guidance("goose")).toContain("with tools_call");
  expect(guidance("goose")).not.toContain("select:mcp__ace__");
  const antigravity = acpInjection(
    { ...connection, listing: acpToolListing("antigravity") },
    "antigravity",
  ).developerInstructions;
  expect(antigravity).toContain("call_mcp_tool");
  expect(antigravity).not.toContain("tools_call");
});

it("a read-only session hears which ace tools still work, on every provider", () => {
  for (const provider of ProviderKind.options) {
    const readOnly = developerInstructions(provider, { access: "read-only" });
    expect(readOnly, provider).toContain("This session is read-only");
    expect(readOnly, provider).toContain("thread_read");
    expect(developerInstructions(provider, { access: "full-access" }), provider).not.toContain(
      "read-only",
    );
  }
  // The shared server text never varies by session.
  expect(aceInstructions).not.toContain("read-only");
});
