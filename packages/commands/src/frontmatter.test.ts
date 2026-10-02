import { it, expect } from "vitest";
import { parseMarkdown, resolveCommand } from "./index.ts";
it("accepts empty YAML frontmatter and expands the body without metadata", () => {
  const parsed = parseMarkdown("---\n---\nHello", {
    source: "empty",
    name: "hello",
    scope: "user",
    format: "library",
  });
  expect(parsed.diagnostics).toEqual([]);
  const command = parsed.commands[0];
  if (!command) throw new Error("Missing command");
  expect(resolveCommand(command, {}, [], "codex")).toEqual({
    ok: true,
    plan: { kind: "prompt", provider: "codex", text: "Hello" },
  });
});

it("expands declared variables with namespace separators consistently with their schema", () => {
  const parsed = parseMarkdown(
    "---\narguments:\n  issue:id: {type: string, required: true}\n---\nIssue {{issue:id}}",
    { source: "namespaced", name: "issue", scope: "user", format: "library" },
  );
  const command = parsed.commands[0];
  if (!command) throw new Error("Missing snippet");
  expect(resolveCommand(command, { "issue:id": "42" }, [], "claude")).toMatchObject({
    ok: true,
    plan: { text: "Issue 42" },
  });
});
