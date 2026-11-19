import { expect, test } from "vitest";
import { checkMcpServer, mcpServersNote, mcpServerWord } from "./mcp-server-form.ts";

test("a command server keeps its arguments, quoted ones whole", () => {
  expect(
    checkMcpServer({
      name: "files",
      transport: "command",
      address: `npx -y @modelcontextprotocol/server-filesystem "/Users/ada/My Docs"`,
    }),
  ).toEqual({
    ok: true,
    name: "files",
    server: {
      transport: "command",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/ada/My Docs"],
    },
    display: `npx -y @modelcontextprotocol/server-filesystem "/Users/ada/My Docs"`,
  });
});

test("an HTTP server needs a plain http or https URL", () => {
  expect(
    checkMcpServer({ name: "docs", transport: "http", address: " https://example.com/mcp " }),
  ).toMatchObject({ ok: true, server: { transport: "http", url: "https://example.com/mcp" } });
  for (const address of ["ftp://example.com", "https://u:p@example.com/mcp", "https://x.dev/?k=1"])
    expect(checkMcpServer({ name: "docs", transport: "http", address })).toMatchObject({
      ok: false,
      field: "address",
    });
});

test("names follow the provider's rules: no spaces, not ace, not one already listed", () => {
  const draft = { transport: "command" as const, address: "server" };
  expect(checkMcpServer({ ...draft, name: "my server" })).toMatchObject({ field: "name" });
  expect(checkMcpServer({ ...draft, name: "ace" })).toMatchObject({ field: "name" });
  expect(checkMcpServer({ ...draft, name: "vercel" }, ["vercel"])).toMatchObject({
    field: "name",
    problem: "A server named vercel is already there.",
  });
  expect(checkMcpServer({ ...draft, name: "" })).toMatchObject({ field: "name" });
});

test("a server waiting for its own sign-in reads as the server's state, not a failure", () => {
  expect(mcpServerWord("needs_auth")).toBe("Not signed in");
  expect(mcpServerWord("disabled")).toBe("Off");
  expect(mcpServerWord("unknown")).toBeUndefined();
});

test("an idle provider explains why no servers show", () => {
  const sources = { groups: [], servers: [], canAdd: false, appliesNextTurn: false };
  expect(mcpServersNote({ ...sources, live: false }, "Codex")).toBe(
    "Codex's MCP servers show here while one of its threads is running.",
  );
  expect(mcpServersNote({ ...sources, live: true, appliesNextTurn: true }, "Codex")).toBe(
    "Changes apply on the next turn.",
  );
  expect(mcpServersNote({ ...sources, live: true }, "Codex")).toBeUndefined();
});
