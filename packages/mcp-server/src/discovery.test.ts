import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverMcpServers, discoveryPaths } from "./index.ts";
import type { ProviderKind } from "@ace/protocol";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function roots() {
  const home = await mkdtemp(join(tmpdir(), "ace-mcp-discovery-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return { home, cwd: join(home, "project"), signal: new AbortController().signal };
}
const cases: [ProviderKind, string][] = [
  [
    "codex",
    '[mcp_servers.test]\nurl = "https://example.com?secret=token"\nhttp_headers = { Authorization = "secret" }\n',
  ],
  [
    "claude",
    '{"mcpServers":{"test":{"type":"http","url":"https://example.com?secret=token","headers":{"Authorization":"secret"}}}}',
  ],
  [
    "opencode",
    '{// comment\n"mcp":{"test":{"type":"remote","url":"https://example.com?secret=token","headers":{"Authorization":"secret"}}},}',
  ],
  ["cursor", '{"mcpServers":{"test":{"url":"https://example.com?secret=token"}}}'],
  ["antigravity", '{"mcpServers":{"test":{"serverUrl":"https://example.com?secret=token"}}}'],
];
for (const [provider, text] of cases) {
  it(`discovers ${provider} MCP config without writes or secret-bearing metadata`, async () => {
    const root = await roots();
    const path = discoveryPaths(provider, root.home, root.cwd)[0];
    if (!path) throw new Error("Expected provider config path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    const result = await discoverMcpServers({ ...root, provider });
    expect(result.issues).toEqual([]);
    expect(result.servers).toEqual([
      { provider, name: "test", source: path, transport: "http", enabled: true },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(await readFile(path, "utf8")).toBe(text);
  });
}
it("discovers Claude project entries and local stdio servers", async () => {
  const root = await roots();
  const path = join(root.home, ".claude.json");
  await writeFile(
    path,
    JSON.stringify({
      projects: { [root.cwd]: { mcpServers: { local: { command: "node", args: ["secret"] } } } },
    }),
  );
  expect((await discoverMcpServers({ ...root, provider: "claude" })).servers).toEqual([
    {
      provider: "claude",
      name: "local",
      transport: "stdio",
      enabled: true,
      source: `${path}#project`,
    },
  ]);
});
it("reads native MCP API results for Codex, Claude and OpenCode", async () => {
  const root = await roots();
  const native: [ProviderKind, unknown][] = [
    ["codex", { data: [{ name: "api-server", enabled: false }] }],
    ["claude", [{ name: "api-server", status: "connected" }]],
    ["opencode", { "api-server": { status: "connected" } }],
  ];
  for (const [provider, value] of native) {
    const result = await discoverMcpServers({
      ...root,
      provider,
      api: {
        async read() {
          return value;
        },
      },
    });
    expect(result.issues).toEqual([]);
    expect(result.servers).toMatchObject([
      { provider, name: "api-server", source: "api", enabled: provider !== "codex" },
    ]);
  }
});
it("reports invalid and oversized files, continues discovery and honors cancellation", async () => {
  const root = await roots();
  const invalid = join(root.home, "invalid.json");
  const oversized = join(root.home, "oversized.json");
  const valid = join(root.home, "valid.json");
  await writeFile(invalid, "{");
  await writeFile(oversized, "x".repeat(1024 * 1024 + 1));
  await writeFile(valid, '{"mcpServers":{"ok":{"command":"node","enabled":false}}}');
  const options = {
    ...root,
    provider: "cursor" as const,
    configPaths: [invalid, oversized, valid],
  };
  const result = await discoverMcpServers(options);
  expect(result.issues).toEqual([
    { source: invalid, code: "invalid" },
    { source: oversized, code: "oversize" },
  ]);
  expect(result.servers).toMatchObject([{ name: "ok", enabled: false }]);
  expect(await discoverMcpServers({ ...root, provider: "acp" })).toEqual({
    servers: [],
    issues: [],
  });
  const cancel = new AbortController();
  cancel.abort();
  await expect(discoverMcpServers({ ...options, signal: cancel.signal })).rejects.toThrow();
});

it("honors Claude project opt-outs across config and API scopes without changing files", async () => {
  const root = await roots();
  const path = join(root.home, ".claude.json");
  const text = JSON.stringify({
    mcpServers: { global: { command: "node" }, regular: { command: "node" } },
    projects: {
      [root.cwd]: {
        mcpServers: { local: { command: "node" } },
        disabledMcpServers: ["global", "local", "api-server"],
        enabledMcpServers: ["global"],
      },
      "/other": { disabledMcpServers: ["regular"] },
    },
  });
  await writeFile(path, text);
  const result = await discoverMcpServers({
    ...root,
    provider: "claude",
    api: {
      async read() {
        return [{ name: "api-server", status: "connected" }];
      },
    },
  });
  expect(result.issues).toEqual([]);
  expect(result.servers).toMatchObject([
    { name: "global", enabled: false },
    { name: "regular", enabled: true },
    { name: "local", enabled: false },
    { name: "api-server", enabled: false },
  ]);
  expect(await readFile(path, "utf8")).toBe(text);
});
