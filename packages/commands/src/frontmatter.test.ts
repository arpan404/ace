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
