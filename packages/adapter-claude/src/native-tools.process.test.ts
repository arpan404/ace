import { expect, test } from "vitest";
import { harness, subtype } from "./session.test-helper.ts";
import { list, object } from "./native.ts";

test("a Full access Claude session keeps Claude Code's prompt, tools, settings and the person's MCP servers beside ace's", async () => {
  const h = await harness(
    undefined,
    "root",
    { mcpServers: { mine: { type: "http", url: "http://127.0.0.1:12345/mcp" } } },
    {
      permissionMode: "bypassPermissions",
      aceMcp: { url: "http://127.0.0.1:9012/mcp", bearer: "b".repeat(64) },
    },
  );
  try {
    const control = object(
      (await h.wait((f) => subtype("fake_control")(f) && isInitialize(f.data))).data,
    );
    // Every setting source loads, so CLAUDE.md, skills, plugins and the person's own MCP
    // servers apply; nothing makes ace's MCP config exclusive.
    expect(control["settings"]).toEqual({
      permissionMode: "bypassPermissions",
      settingSources: ["user", "project", "local"],
      strictMcp: false,
    });
    const argv = list(control["argv"]).map(String);
    for (const flag of ["--tools", "--allowedTools", "--disallowedTools", "--strict-mcp-config"])
      expect(argv).not.toContain(flag);
    expect(Object.keys(object(control["mcpServers"])).toSorted()).toEqual(["ace", "mine"]);
    // Claude Code's own system prompt stays; ace's guidance is only appended to it.
    const request = object(control["request"]);
    expect(request["systemPrompt"]).toBeUndefined();
    expect(String(request["appendSystemPrompt"])).toContain("mcp__ace__");
  } finally {
    await h.session.close("shutdown");
  }
});

function isInitialize(data: unknown): boolean {
  return object(object(data)["request"])["subtype"] === "initialize";
}
