import { it, expect } from "vitest";
import { ProviderKind } from "@ace/protocol";
import { parseMarkdown, parseRuntime, resolveCommand } from "./index.ts";
it.each(ProviderKind.options)(
  "%s receives an expanded ace snippet with literal argument values",
  (provider) => {
    const parsed = parseMarkdown(
      "---\narguments:\n  topic: {type: string, required: true}\n---\nExplain {{topic}}",
      { source: "snippet", name: "explain", scope: "user", format: "library" },
    );
    const command = parsed.commands[0];
    if (!command) throw new Error("Missing snippet");
    expect(resolveCommand(command, { topic: "$ARGUMENTS" }, [], provider)).toEqual({
      ok: true,
      plan: { kind: "prompt", provider, text: "Explain $ARGUMENTS" },
    });
  },
);
it.each(["cursor", "antigravity", "acp"] as const)(
  "%s receives its native ACP invocation and rejects a different provider",
  (provider) => {
    const parsed = parseRuntime(
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "plan", description: "Plan", input: { hint: "task" } }],
      },
      { provider, instance: provider, session: provider },
    );
    const command = parsed.commands[0];
    if (!command) throw new Error("Missing native command");
    expect(resolveCommand(command, {}, ["change"], provider)).toMatchObject({
      ok: true,
      plan: { kind: "native", provider, text: "/plan change" },
    });
    expect(resolveCommand(command, {}, [], "codex")).toEqual({
      ok: false,
      error: "unsupported_provider",
    });
  },
);
it("Claude's MCP servers reach the composer by name only, never with their connection state", () => {
  const parsed = parseRuntime(
    {
      type: "system",
      subtype: "init",
      slash_commands: [],
      mcp_servers: [
        { name: "vercel", status: "needs-auth" },
        { name: "github", status: "failed" },
      ],
    },
    { provider: "claude", instance: "claude", session: "claude" },
  );
  expect(parsed.commands.map((command) => command.name)).toEqual(["vercel", "github"]);
  expect(JSON.stringify(parsed.commands)).not.toMatch(/needs-auth|failed/);
});
