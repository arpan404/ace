import { describe, expect, test } from "vitest";
import { parseSpadeBotPlugins, spadePluginLine } from "./plugins.ts";

const page = JSON.stringify({
  cli: false,
  problem: null,
  plugins: [
    {
      name: "style",
      version: "1.0",
      enabled_in_ace: true,
      allowed: true,
      rules: ["tabs"],
      hooks: ["PreToolUse", "Stop"],
      servers: [{ name: "lint", state: "running", tools: 3, problem: null }],
      remote: [{ name: "docs", url: "https://docs.example/mcp" }],
      not_used: [{ what: "rule ts", reason: "It applies only to some files." }, { what: "broken" }],
      added_later: 1,
    },
    { version: "no name" },
  ],
});

describe("a bot's plugins", () => {
  test("a page keeps what Spade sent and leaves out entries it can't read", () => {
    const parsed = parseSpadeBotPlugins(page);
    expect(parsed?.plugins).toHaveLength(1);
    const style = parsed?.plugins[0];
    expect(style?.notUsed).toEqual([{ what: "rule ts", reason: "It applies only to some files." }]);
    expect(style?.servers[0]).toEqual({
      name: "lint",
      state: "running",
      tools: 3,
      problem: undefined,
    });
    expect(parseSpadeBotPlugins("not json")).toBeUndefined();
  });

  test("a row says what the plugin brings, or why it brings nothing", () => {
    const style = parseSpadeBotPlugins(page)?.plugins[0];
    if (!style) throw new Error("no plugin");
    expect(spadePluginLine(style)).toBe("1 rule, 2 hooks, 2 servers");
    expect(spadePluginLine({ ...style, enabledInAce: false })).toBe("Turned off in ace");
    expect(
      spadePluginLine({
        ...style,
        servers: [{ name: "lint", state: "failed", tools: 0, problem: undefined }],
      }),
    ).toContain("lint stopped too often");
    expect(spadePluginLine({ ...style, rules: [], hooks: [], servers: [], remote: [] })).toBe(
      "Nothing Spade uses",
    );
  });
});
