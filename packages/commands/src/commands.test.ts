import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { describe, it, expect } from "vitest";
import {
  CommandCatalog,
  parseMarkdown,
  parseRuntime,
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
    for (let i = 0; i < 8; i++) catalog.recordUse("review-alpha#review-alpha");
    expect(catalog.list(target, "rvb", 1).commands.map((d) => d.name)).toEqual(["review-beta"]);
    expect(catalog.list(target, "review-", 1).commands.map((d) => d.name)).toEqual([
      "review-alpha",
    ]);
    now = 86400000 * 100;
    for (let i = 0; i < 8; i++) catalog.recordUse("review-beta#review-beta");
    expect(catalog.list(target, "review-", 1).commands.map((d) => d.name)).toEqual(["review-beta"]);
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
    expect(
      catalog.replaceSource("0", {
        commands: [command("Replacement", "library", "0")],
        diagnostics: [],
      }),
    ).toBe(true);
    expect(catalog.resolve(target, "0#review")).toEqual({
      ok: true,
      plan: { kind: "prompt", provider: "claude", text: "Replacement" },
    });
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
