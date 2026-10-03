import { expect, it } from "vitest";
import {
  codexInjection,
  claudeInjection,
  openCodeInjection,
  acpInjection,
  cursorSdkInjection,
} from "./index.ts";
import { parse as parseToml } from "smol-toml";

const connection = { url: "http://127.0.0.1:12345/mcp", bearer: "a".repeat(64) };
it("passes Codex overrides as exact TOML values with the bearer only in its environment", () => {
  const result = codexInjection(connection);
  expect(result.args).toEqual([
    "-c",
    'mcp_servers.ace.url="http://127.0.0.1:12345/mcp"',
    "-c",
    'mcp_servers.ace.bearer_token_env_var="ACE_MCP_BEARER_TOKEN"',
  ]);
  expect(parseToml(`${result.args[1]}\n${result.args[3]}`)).toEqual({
    mcp_servers: { ace: { url: connection.url, bearer_token_env_var: "ACE_MCP_BEARER_TOKEN" } },
  });
  expect(result.env).toEqual({ ACE_MCP_BEARER_TOKEN: connection.bearer });
  expect(result.args.join(" ")).not.toContain(connection.bearer);
  expect(result.developerInstructions).toContain("acceptance, not completion");
});
it("builds Claude Agent SDK HTTP mcpServers with bearer headers", () => {
  const result = claudeInjection(connection);
  expect(result.mcpServers).toEqual({
    ace: {
      type: "http",
      url: connection.url,
      headers: { Authorization: `Bearer ${connection.bearer}` },
    },
  });
  expect(result.developerInstructions).toContain("mcp__ace__*");
});
it("builds OpenCode config content with remote type, headers and OAuth disabled", () => {
  const result = openCodeInjection(connection);
  expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT)).toEqual({
    mcp: {
      ace: {
        type: "remote",
        url: connection.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${connection.bearer}` },
      },
    },
  });
  expect(result.developerInstructions).toContain("ace_ace_*");
});
for (const provider of ["cursor", "antigravity", "acp"] as const) {
  it(`builds ${provider} ACP HTTP session definitions with an array of headers`, () => {
    const result = acpInjection(connection, provider);
    expect(result.mcpServers).toEqual([
      {
        type: "http",
        name: "ace",
        url: connection.url,
        headers: [{ name: "Authorization", value: `Bearer ${connection.bearer}` }],
      },
    ]);
    expect(result.developerInstructions).toContain("live status");
  });
}
it("refuses to inject ace credentials into remote or decorated URLs", () => {
  for (const url of [
    "http://example.com:12345/mcp",
    "https://127.0.0.1:12345/mcp",
    "http://127.0.0.1:12345/mcp?token=bad",
    "http://user:pass@127.0.0.1:12345/mcp",
  ]) {
    expect(() => codexInjection({ ...connection, url })).toThrow();
    expect(() => claudeInjection({ ...connection, url })).toThrow();
    expect(() => openCodeInjection({ ...connection, url })).toThrow();
    expect(() => acpInjection({ ...connection, url })).toThrow();
    expect(() => cursorSdkInjection({ ...connection, url })).toThrow();
  }
});

it("injects Cursor HTTP lease credentials through the SDK MCP policy path", () => {
  const result = cursorSdkInjection(connection);
  expect(result.mcpServers).toEqual({
    ace: {
      type: "http",
      url: connection.url,
      headers: { Authorization: `Bearer ${connection.bearer}` },
    },
  });
  expect(result.developerInstructions).toContain("live status");
});
