import { describe, it, expect } from "vitest";
import {
  CommandCatalog,
  parseMarkdown,
  parseOpenCodeConfig,
  resolveCommand,
  type Definition,
} from "./index.ts";
const target = { provider: "claude", instance: "personal", session: "thread-a" } as const;
function command(
  text: string,
  format: "library" | "claude" | "codex" | "opencode" = "library",
  source = "file",
  scope: "user" | "workspace" = "user",
): Definition {
  const parsed = parseMarkdown(text, { source, name: "review", scope, format });
  const first = parsed.commands[0];
  if (!first) throw new Error(JSON.stringify(parsed.diagnostics));
  return first;
}
const library = `---
name: explain
description: Explain a file
arguments:
  file:
    type: string
    required: true
  count:
    type: number
    default: 3
  verbose:
    type: boolean
    default: false
---
Explain {{file}} {{count}} {{verbose}}; literal \\{{file}}; $ARGUMENTS`;
describe("provider formats and planning", () => {
  it("preserves Claude metadata and leaves native context injection to Claude", () => {
    const d = command(
      '---\ndescription: Review changes\nargument-hint: "[path]"\nallowed-tools: Read, Bash(git diff:*)\nfuture: yes\n---\nReview $ARGUMENTS !`git diff`',
      "claude",
    );
    expect(resolveCommand(d, {}, ["src/a b.ts"], "claude")).toEqual({
      ok: true,
      plan: {
        kind: "native",
        provider: "claude",
        text: '/review "src/a b.ts"',
        metadata: {
          description: "Review changes",
          "argument-hint": "[path]",
          "allowed-tools": "Read, Bash(git diff:*)",
          future: "yes",
        },
      },
    });
    expect(resolveCommand(d, {}, [], "codex")).toEqual({
      ok: false,
      error: "unsupported_provider",
    });
  });
  it("expands Codex named and positional placeholders once and preserves escaped dollars", () => {
    const d = command(
      "---\ndescription: Prepare PR\nargument-hint: FILE=<path>\n---\n$FILE / $1 / $9 / $ARGUMENTS / $$FILE",
      "codex",
    );
    expect(resolveCommand(d, { FILE: "$1" }, ["a b", "c"], "codex")).toEqual({
      ok: true,
      plan: { kind: "prompt", provider: "codex", text: "$1 / a b /  / a b c / $FILE" },
    });
    expect(resolveCommand(d, {}, [], "codex")).toEqual({
      ok: false,
      error: "missing_argument",
      argument: "FILE",
    });
  });
  it("keeps OpenCode JSONC agent/model/subtask and unknown metadata on native plans", () => {
    const parsed = parseOpenCodeConfig(
      '{//comment\n"command":{"test":{"template":"Run $ARGUMENTS","description":"Tests","agent":"plan","model":"local/model","subtask":true,"future":42},"broken":{}}}',
      { source: "config", name: "unused", scope: "workspace", instance: "oc" },
    );
    expect(parsed.diagnostics).toHaveLength(1);
    const d = parsed.commands[0];
    if (!d) throw new Error("Missing command");
    expect(resolveCommand(d, {}, ["all"], "opencode")).toEqual({
      ok: true,
      plan: {
        kind: "native",
        provider: "opencode",
        text: "/test all",
        metadata: {
          template: "Run $ARGUMENTS",
          description: "Tests",
          agent: "plan",
          model: "local/model",
          subtask: true,
          future: 42,
        },
      },
    });
    const markdown = command("---\ndescription: Run tests\nagent: build\n---\nRun $1", "opencode");
    expect(resolveCommand(markdown, {}, ["unit"], "opencode")).toMatchObject({
      ok: true,
      plan: { kind: "native", text: "/review unit" },
    });
  });
  it("returns diagnostics for malformed YAML, duplicate keys and mistyped defaults", () => {
    for (const { text, message } of [
      {
        text: "---\nname: [oops\n---\nbody",
        message:
          "The settings at the top of this prompt have invalid syntax. Check the names, brackets and indentation.",
      },
      {
        text: "---\nname: a\nname: b\n---\nbody",
        message:
          "The settings at the top of this prompt have invalid syntax. Check the names, brackets and indentation.",
      },
      {
        text: "---\narguments:\n  x: {type: number, default: nope}\n---\nbody",
        message:
          "A prompt setting or argument has an unsupported value. Check the names and values at the top of the file.",
      },
      {
        text: "---\nname: a\nbody",
        message:
          "The settings at the top of this prompt need a closing --- line. Add it before the prompt text.",
      },
    ]) {
      const parsed = parseMarkdown(text, {
        source: "broken",
        name: "bad",
        format: "library",
        scope: "user",
      });
      expect(parsed.commands).toEqual([]);
      expect(parsed.diagnostics).toEqual([{ source: "broken", message }]);
    }
  });
  it("applies typed defaults, escaping and required validation without expanding inserted values", () => {
    const d = command(library);
    expect(resolveCommand(d, { file: "{{count}}" }, [], "opencode")).toEqual({
      ok: true,
      plan: {
        kind: "prompt",
        provider: "opencode",
        text: "Explain {{count}} 3 false; literal {{file}}; $ARGUMENTS",
      },
    });
    expect(resolveCommand(d, {}, [], "claude")).toEqual({
      ok: false,
      error: "missing_argument",
      argument: "file",
    });
    expect(resolveCommand(d, { file: "x", count: "3" }, [], "claude")).toEqual({
      ok: false,
      error: "invalid_argument",
      argument: "count",
    });
    expect(resolveCommand(d, { file: "x", other: "y" }, [], "claude")).toEqual({
      ok: false,
      error: "invalid_argument",
      argument: "other",
    });
    expect(resolveCommand(command("---\nprovider: codex\n---\nhi"), {}, [], "claude")).toEqual({
      ok: false,
      error: "unsupported_provider",
    });
  });
  it("rejects undeclared template variables, positional library arguments and oversized expansion", () => {
    expect(resolveCommand(command("{{unknown}}"), {}, [], "claude")).toEqual({
      ok: false,
      error: "invalid_argument",
      argument: "unknown",
    });
    expect(resolveCommand(command("plain"), {}, ["ignored"], "claude")).toEqual({
      ok: false,
      error: "invalid_argument",
    });
    const d = command("---\narguments:\n  x: {type: string}\n---\n" + "{{x}}".repeat(5));
    expect(resolveCommand(d, { x: "x".repeat(16384) }, [], "claude")).toEqual({
      ok: false,
      error: "limit_exceeded",
    });
  });
  it("advertises user-invocable skills under their declared name", () => {
    const parsed = parseMarkdown(
      "---\nname: deploy\ndescription: Deploy\nuser-invocable: false\n---\nDo work",
      { source: "skill", name: "directory", scope: "user", format: "claude", skill: true },
    );
    const d = parsed.commands[0];
    if (!d) throw new Error("Missing skill");
    expect(d.name).toBe("deploy");
    const catalog = new CommandCatalog(() => 0);
    catalog.replaceSource("skill", parsed);
    expect(catalog.list(target, "deploy").commands).toEqual([]);
    expect(resolveCommand(d, {}, [], "claude")).toEqual({
      ok: false,
      error: "unsupported_command",
    });
    catalog.replaceSource(
      "skill",
      parseMarkdown("---\nname: deploy\nuser-invocable: true\n---\nDo work", {
        source: "skill",
        name: "directory",
        scope: "user",
        format: "claude",
        skill: true,
      }),
    );
    expect(catalog.list(target, "deploy").commands.map((c) => c.name)).toEqual(["deploy"]);
  });
});
