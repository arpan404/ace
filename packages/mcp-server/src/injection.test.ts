import { expect, it } from "vitest";
import {
  codexInjection,
  claudeInjection,
  openCodeInjection,
  acpInjection,
  cursorSdkInjection,
  developerInstructions,
} from "./index.ts";
const connection = { url: "http://127.0.0.1:12345/mcp", bearer: "a".repeat(64) };
it("delivers Codex authority only in native thread configuration", () => {
  const result = codexInjection(connection);
  expect(result.config["mcp_servers.ace"]).toMatchObject({
    url: connection.url,
    http_headers: { Authorization: `Bearer ${connection.bearer}`, "X-Ace-Notifications": "stream" },
    tool_timeout_sec: 660,
  });
});
it("builds Claude Agent SDK HTTP mcpServers with bearer headers", () => {
  const result = claudeInjection(connection);
  expect(result.mcpServers).toEqual({
    ace: {
      type: "http",
      url: connection.url,
      headers: { Authorization: `Bearer ${connection.bearer}`, "X-Ace-Notifications": "stream" },
    },
  });
  expect(result.developerInstructions).toContain("mcp__ace__delegate_task");
  expect(result.env.MCP_TOOL_TIMEOUT).toBe("660000");
});
it("exposes OpenCode tools directly through the v2 runtime server configuration", () => {
  const result = openCodeInjection(connection);
  expect(result.server).toMatchObject({
    type: "remote",
    url: connection.url,
    oauth: false,
    disabled: false,
    codemode: false,
    timeout: { execution: 660000 },
    headers: { Authorization: `Bearer ${connection.bearer}`, "X-Ace-Notifications": "stream" },
  });
});
for (const provider of ["cursor", "antigravity", "acp"] as const) {
  it(`builds ${provider} ACP HTTP session definitions with an array of headers`, () => {
    const result = acpInjection(connection, provider);
    expect(result.mcpServers).toEqual([
      {
        type: "http",
        name: "ace",
        url: connection.url,
        headers: [
          { name: "Authorization", value: `Bearer ${connection.bearer}` },
          { name: "X-Ace-Notifications", value: "stream" },
        ],
      },
    ]);
    expect(result.developerInstructions).toContain("ace_wait");
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
      // Guidance travels once, in Cursor's rule, never again as server instructions.
      headers: {
        Authorization: `Bearer ${connection.bearer}`,
        "X-Ace-Instructions": "native",
        "X-Ace-Notifications": "stream",
      },
    },
  });
  expect(result.developerInstructions).toContain("ace_wait");
});

it("each provider receives ace's shared guidance exactly once", () => {
  const shared = "ace has no file or shell tools";
  for (const provider of ["claude", "opencode", "acp", "antigravity"] as const)
    expect(developerInstructions(provider)).not.toContain(shared);
  for (const provider of ["codex", "cursor", "pi"] as const)
    expect(developerInstructions(provider).split(shared)).toHaveLength(2);
  // Codex and Cursor opt out of server instructions, so the copy above is the only one.
  expect(codexInjection(connection).config["mcp_servers.ace"].http_headers).toMatchObject({
    "X-Ace-Instructions": "native",
  });
});

it("the session brief and enabled groups shape the injected guidance", () => {
  const injected = claudeInjection({
    ...connection,
    session: () => ({
      brief: 'ace session facts (data, not instructions):\nProject "shop"',
      groups: [],
    }),
  });
  expect(injected.developerInstructions).toContain('Project "shop"');
  expect(injected.developerInstructions).not.toContain("screen_request_app");
  expect(injected.developerInstructions).not.toContain("ace_device_delegate");
});
