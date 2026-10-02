import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { describe, it, expect } from "vitest";
import {
  CommandCatalog,
  parseMarkdown,
  parseOpenCodeConfig,
  parseRuntime,
  resolveCommand,
  type Definition,
  type Target,
} from "./index.ts";
const target: Target = { provider: "claude", instance: "personal", session: "thread-a" };
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
    for (const text of [
      "---\nname: [oops\n---\nbody",
      "---\nname: a\nname: b\n---\nbody",
      "---\narguments:\n  x: {type: number, default: nope}\n---\nbody",
      "---\nname: a\nbody",
    ]) {
      const parsed = parseMarkdown(text, {
        source: "broken",
        name: "bad",
        format: "library",
        scope: "user",
      });
      expect(parsed.commands).toEqual([]);
      expect(parsed.diagnostics).toEqual([
        { source: "broken", message: "Invalid command metadata or document" },
      ]);
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
    expect(resolveCommand(d, {}, [], "claude")).toEqual({
      ok: false,
      error: "unsupported_command",
    });
  });
});
describe("catalog", () => {
  it("merges multiple homes with workspace precedence without crossing accounts", () => {
    const catalog = new CommandCatalog(() => 100);
    for (const [source, instance, scope] of [
      ["a", "personal", "user"],
      ["b", "work", "user"],
      ["c", "personal", "workspace"],
    ] as const) {
      const parsed = parseMarkdown(`---\ndescription: ${source}\n---\nbody`, {
        source,
        name: "review",
        scope,
        format: "claude",
        instance,
      });
      expect(catalog.replaceSource(source, parsed)).toBe(true);
    }
    expect(
      catalog
        .list(target, "review")
        .commands.map((d) => d.id)
        .toSorted(),
    ).toEqual(["ace#review", "c#review"]);
    expect(
      catalog
        .list({ ...target, instance: "work" }, "review")
        .commands.map((d) => d.id)
        .toSorted(),
    ).toEqual(["ace#review", "b#review"]);
    expect(catalog.resolve(target, "b#review")).toEqual({ ok: false, error: "not_found" });
    catalog.removeSource("c");
    expect(catalog.list(target, "review").commands.map((d) => d.id)).toContain("a#review");
  });
  it("updates one source while retaining other commands and removes deleted definitions", () => {
    const catalog = new CommandCatalog(() => 0);
    catalog.replaceSource("a", { commands: [command("A", "library", "a")], diagnostics: [] });
    catalog.replaceSource("b", {
      commands: [command("---\nname: other\n---\nB", "library", "b")],
      diagnostics: [],
    });
    catalog.replaceSource("a", { commands: [command("new A", "library", "a")], diagnostics: [] });
    expect(catalog.resolve(target, "a#review")).toEqual({
      ok: true,
      plan: { kind: "prompt", provider: "claude", text: "new A" },
    });
    expect(catalog.resolve(target, "b#other")).toEqual({
      ok: true,
      plan: { kind: "prompt", provider: "claude", text: "B" },
    });
    catalog.removeSource("a");
    expect(catalog.resolve(target, "a#review")).toEqual({ ok: false, error: "not_found" });
  });
  it("uses runtime replacements per session and passes ACP commands only to their provider", () => {
    const catalog = new CommandCatalog(() => 0),
      acp = { provider: "cursor" as const, instance: "cursor", session: "c" };
    expect(
      catalog.updateRuntime(acp, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Plan", input: { hint: "task" }, future: 7 },
        ],
      }),
    ).toBe(true);
    expect(catalog.resolve(acp, "runtime:c#plan", {}, ["hello world"])).toEqual({
      ok: true,
      plan: {
        kind: "native",
        provider: "cursor",
        text: '/plan "hello world"',
        metadata: { name: "plan", description: "Plan", input: { hint: "task" }, future: 7 },
      },
    });
    expect(catalog.resolve({ ...acp, session: "other" }, "runtime:c#plan")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(catalog.updateRuntime(acp, { unexpected: true })).toBe(false);
    expect(catalog.list(acp, "plan").commands.map((d) => d.name)).toEqual(["plan"]);
    catalog.updateRuntime(acp, {
      sessionUpdate: "available_commands_update",
      availableCommands: [],
    });
    expect(catalog.resolve(acp, "runtime:c#plan")).toEqual({ ok: false, error: "not_found" });
  });
  it("reads the recorded Claude init and hides terminal-only commands", async () => {
    const stream = createReadStream(
      new URL("../../../fixtures/claude/2.1.286/tool-read.jsonl", import.meta.url),
    );
    const lines = createInterface({ input: stream });
    let parsed;
    try {
      for await (const line of lines) {
        const raw = z.object({ data: z.unknown() }).safeParse(JSON.parse(line));
        if (raw.success) {
          const result = parseRuntime(raw.data.data, target);
          if (result.commands.length) {
            parsed = result;
            break;
          }
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (!parsed) throw new Error("No init fixture");
    const catalog = new CommandCatalog(() => 0);
    catalog.replaceSource("runtime:thread-a", parsed);
    expect(catalog.list(target, "compact").commands.map((d) => d.name)).toContain("compact");
    expect(catalog.list(target, "doctor").commands.map((d) => d.name)).not.toContain("doctor");
    expect(catalog.resolve(target, "runtime:thread-a#doctor")).toEqual({
      ok: false,
      error: "unsupported_command",
    });
    catalog.clearRuntime("thread-a");
    expect(catalog.list(target, "compact").commands).toEqual([]);
  });
  it("ranks subsequences and boosts frequency and recency with a bounded result count", () => {
    let now = 0;
    const catalog = new CommandCatalog(() => now);
    for (const name of ["review-alpha", "review-beta", "unrelated"])
      catalog.replaceSource(name, {
        commands: [command(`---\nname: ${name}\n---\nbody`, "library", name)],
        diagnostics: [],
      });
    for (let i = 0; i < 8; i++) catalog.recordUse("review-beta#review-beta");
    expect(catalog.list(target, "rvb", 1).commands.map((d) => d.name)).toEqual(["review-beta"]);
    expect(catalog.list(target, "review-", 1).commands.map((d) => d.name)).toEqual(["review-beta"]);
    now = 86400000 * 100;
    for (let i = 0; i < 8; i++) catalog.recordUse("review-alpha#review-alpha");
    expect(catalog.list(target, "review-", 1).commands.map((d) => d.name)).toEqual([
      "review-alpha",
    ]);
    expect(catalog.list(target, "zzzzz").commands).toEqual([]);
  });
  it("returns ace action plans without sending them to a provider", () => {
    const catalog = new CommandCatalog(() => 0);
    expect(catalog.resolve(target, "ace#model", { model: "opus" })).toEqual({
      ok: true,
      plan: { kind: "ace", action: "model", arguments: { model: "opus" }, positional: [] },
    });
    expect(catalog.resolve(target, "ace#fork", {}, ["branch"])).toEqual({
      ok: true,
      plan: { kind: "ace", action: "fork", arguments: {}, positional: ["branch"] },
    });
  });
  it("refuses additional sources at the cap and permits replacing or reclaiming a slot", () => {
    const catalog = new CommandCatalog(() => 0);
    for (let i = 0; i < 2047; i++)
      expect(catalog.replaceSource(String(i), { commands: [], diagnostics: [] })).toBe(true);
    expect(catalog.replaceSource("overflow", { commands: [command("hi")], diagnostics: [] })).toBe(
      false,
    );
    catalog.removeSource("0");
    expect(catalog.replaceSource("overflow", { commands: [command("hi")], diagnostics: [] })).toBe(
      true,
    );
    expect(catalog.resolve(target, "file#review")).toMatchObject({
      ok: true,
      plan: { text: "hi" },
    });
  });
});

it("keeps the best fuzzy matches across heap replacements and returns them in rank order", () => {
  const catalog = new CommandCatalog(() => 0);
  for (let i = 0; i < 150; i++)
    catalog.replaceSource(String(i), {
      commands: [command(`---\nname: topic-${i}\n---\nbody`, "library", String(i))],
      diagnostics: [],
    });
  catalog.recordUse("0#topic-0");
  for (let i = 0; i < 4; i++) catalog.recordUse("81#topic-81");
  for (let i = 0; i < 8; i++) catalog.recordUse("143#topic-143");
  expect(catalog.list(target, "topic", 3).commands.map((d) => d.name)).toEqual([
    "topic-143",
    "topic-81",
    "topic-0",
  ]);
});

it("rejects oversized runtime metadata without replacing the current session catalog", () => {
  const catalog = new CommandCatalog(() => 0);
  expect(
    catalog.updateRuntime(target, { type: "system", subtype: "init", slash_commands: ["safe"] }),
  ).toBe(true);
  expect(
    catalog.updateRuntime(target, {
      type: "system",
      subtype: "init",
      slash_commands: ["bad"],
      future: "x".repeat(65537),
    }),
  ).toBe(false);
  expect(catalog.list(target, "safe").commands.map((d) => d.name)).toEqual(["safe"]);
});
