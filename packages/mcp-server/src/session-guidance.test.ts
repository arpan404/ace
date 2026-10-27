import { expect, it } from "vitest";
import { ProviderKind } from "@ace/protocol";
import {
  acpInjection,
  acpShowsServerInstructions,
  acpToolListing,
  aceInstructions,
  cursorSdkInjection,
  cursorToolListing,
  developerInstructions,
} from "./index.ts";

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
  expect(developerInstructions("acp")).toContain(
    "such as thread_start or thread_control, with tools_call",
  );
  // Cursor sees only tool names: it reads a schema with GetMcpTools and calls with CallMcpTool.
  // Its list holds every tool, so ace never offers it tools_call or Claude's search.
  const cursor = developerInstructions("cursor");
  expect(cursor).toContain('GetMcpTools (server "ace", toolName)');
  expect(cursor).toContain("call it with CallMcpTool, e.g. thread_start");
  expect(cursor).not.toContain("tools_call");
  expect(cursor).not.toContain("select:mcp__ace__");
  // Antigravity reaches a deferred tool through its own call_mcp_tool, never Claude's search.
  const antigravity = developerInstructions("antigravity");
  expect(antigravity).toContain('call_mcp_tool (ServerName "ace", ToolName, Arguments)');
  expect(antigravity).toContain("thread_start");
  expect(antigravity).not.toContain("select:mcp__ace__");
});

it("Claude's guidance still reaches an unlisted ace tool after its list narrows to core", () => {
  // Rendered once with the full list; a model switch can later drop tool search and leave the
  // core list, so the same text must name the call a core list offers (tools_call).
  const text = developerInstructions("claude", { listing: "all" });
  expect(text).toContain("select:mcp__ace__thread_start");
  expect(text).toContain("tools_call {name, arguments}");
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
  expect(antigravity).toContain("tools_call");
});

/** What the daemon hands an ACP agent's own channel (system prompt or first prompt). */
const ownChannel = (cli: string | undefined, provider: "antigravity" | "acp" = "acp") =>
  acpInjection(
    {
      ...connection,
      listing: acpToolListing(cli),
      serverInstructions: acpShowsServerInstructions(cli),
    },
    provider,
  ).developerInstructions;

it("ace's guidance reaches an ACP agent once: in server instructions it shows, else its own channel", () => {
  // Gemini CLI and Claude Code put server instructions in the model's context: no second copy.
  for (const cli of ["gemini", "claude-acp"])
    expect(ownChannel(cli), cli).not.toContain(aceInstructions);
  // Antigravity only files them in instructions.md beside its tool definitions, and Qwen Code
  // or an unreviewed agent may never read them: ace's guidance rides in their own channel.
  expect(ownChannel("antigravity", "antigravity")).toContain(aceInstructions);
  for (const cli of ["qwen-code", "goose", undefined])
    expect(ownChannel(cli), cli ?? "unknown").toContain(aceInstructions);
  // An Antigravity session the daemon renders with no agent facts still carries it.
  expect(developerInstructions("antigravity")).toContain(aceInstructions);
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

it("native apps point at the screen tool the session can actually call", () => {
  const engine = developerInstructions("pi", {
    tools: ["context", "screen_apps", "screen_state", "screen_act"],
  });
  expect(engine).toContain("native app or simulator: screen_state;");
  // Windows, or a daemon without the engine helper, offers only the older session tools.
  const session = developerInstructions("pi", {
    tools: ["context", "screen_open_app", "screen_ui_tree", "screen_ui_act"],
  });
  expect(session).toContain("native app or simulator: screen_open_app;");
  expect(session).not.toContain("screen_state");
});

it("Cursor lists every ace tool while its MCP meta tool shows names only, else a fixed list", () => {
  // With the meta tool on (the SDK's default) a tool Cursor never listed cannot be called, and a
  // listed one costs only its name; without it every listed tool would load in full.
  expect(cursorToolListing(true)).toBe("all");
  expect(cursorToolListing(false)).toBe("static");
  const injected = cursorSdkInjection(connection);
  expect(Object.keys(injected.mcpServers.ace.headers)).not.toContain("X-Ace-Tools");
  expect(injected.developerInstructions).toContain("CallMcpTool");
});
