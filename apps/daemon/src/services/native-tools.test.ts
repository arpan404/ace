import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { readCodexOverrides } from "@ace/plugins/testing/codex-config";
import { codexToolStatus } from "../native-tools/read.ts";
import { cachedToolFiles, nodeFileSystem } from "../native-tools/files.ts";
import { withNativeTools, type NativeToolsContext } from "./native-tools.ts";

let root: string;
let home: string;
let codexHome: string;
let managed: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-native-tools-"));
  home = join(root, "home");
  codexHome = join(home, ".codex");
  managed = join(root, "account-homes", "work");
  await mkdir(codexHome, { recursive: true });
  await mkdir(managed, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const personConfig = `
[model_providers.private]
api_key = "sk-model-provider-secret"
[marketplaces.mine]
source_type = "local"
source = "marketplaces/mine"
[plugins."computer-use@mine"]
enabled = true
[mcp_servers.node_repl]
command = "/Applications/Host.app/node_repl"
env = { TOKEN = "mcp-env-secret" }
`;

function harness(provider: "codex" | "claude", values: Record<string, unknown> = {}) {
  const opened: SessionContext[] = [];
  const logs: string[] = [];
  const inner = {
    provider,
    openSession: async (session: SessionContext) => {
      opened.push(session);
      return {} as never;
    },
  } as unknown as ProviderAdapter;
  const context: NativeToolsContext = {
    settings: {
      get: async (key) => ({ value: values[key] }),
    },
    log: {
      log: (level, message, data) => logs.push(`${level} ${message} ${JSON.stringify(data)}`),
    },
    env: { HOME: home },
    files: cachedToolFiles(nodeFileSystem),
  };
  const adapter = withNativeTools(context, inner);
  const open = (session: Partial<SessionContext> = {}) =>
    adapter.openSession({
      threadId: ThreadId.parse("thread-1"),
      cwd: root,
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: () => {},
      ...session,
    } as SessionContext);
  return { opened, logs, open };
}

/** The config a Codex launch reads back from its `-c` overrides, parsed as Codex does. */
function readBack(args: readonly string[] | undefined, base: Record<string, unknown> = {}) {
  return readCodexOverrides(args ?? [], base);
}

test("a managed Codex account starts with the person's plugins, marketplaces and MCP servers", async () => {
  await writeFile(join(codexHome, "config.toml"), personConfig);
  const h = harness("codex");
  await h.open({ instanceHomeDir: managed });
  const back = readBack(h.opened[0]?.toolConfigArgs);
  expect(back).toEqual({
    marketplaces: { mine: { source_type: "local", source: join(codexHome, "marketplaces/mine") } },
    plugins: { "computer-use@mine": { enabled: true } },
    mcp_servers: {
      node_repl: { command: "/Applications/Host.app/node_repl", env: { TOKEN: "mcp-env-secret" } },
    },
  });
});

test("a managed account's node_repl runs against its own Codex home, never the source's", async () => {
  await writeFile(
    join(codexHome, "config.toml"),
    `[mcp_servers.node_repl]\ncommand = "/x"\nenv = { CODEX_HOME = ${JSON.stringify(codexHome)} }\n`,
  );
  const h = harness("codex");
  await h.open({ instanceHomeDir: managed });
  const args = h.opened[0]?.toolConfigArgs ?? [];
  expect(readBack(args)["mcp_servers"]).toEqual({
    node_repl: { command: "/x", env: { CODEX_HOME: managed } },
  });
  expect(args.join(" ")).not.toContain(codexHome);
});

test("a Codex account that turned node_repl off in ace keeps it off", async () => {
  await writeFile(join(codexHome, "config.toml"), personConfig);
  const own = "[mcp_servers.node_repl]\nenabled = false\n";
  await writeFile(join(managed, "config.toml"), own);
  const h = harness("codex");
  await h.open({ instanceHomeDir: managed });
  const back = readBack(h.opened[0]?.toolConfigArgs, {
    mcp_servers: { node_repl: { enabled: false } },
  });
  expect(back["mcp_servers"]).toMatchObject({
    node_repl: { enabled: false, command: "/Applications/Host.app/node_repl" },
  });
});

test("a tool source entry Codex can't name is left out and logged by name only", async () => {
  await writeFile(
    join(codexHome, "config.toml"),
    '[mcp_servers."a.b@c"]\ncommand = "/secret/path"\n[plugins."x@y"]\nenabled = true\n',
  );
  const h = harness("codex");
  await h.open({ instanceHomeDir: managed });
  expect(readBack(h.opened[0]?.toolConfigArgs)).toEqual({ plugins: { "x@y": { enabled: true } } });
  const logged = h.logs.join("\n");
  expect(logged).toContain("mcp_servers.a.b@c");
  expect(logged).not.toContain("/secret/path");
});

test("Codex logs name the carried entries but never their values or other secrets", async () => {
  await writeFile(join(codexHome, "config.toml"), personConfig);
  const h = harness("codex");
  await h.open({ instanceHomeDir: managed });
  const logged = h.logs.join("\n");
  expect(logged).toContain("mcp_servers.node_repl");
  expect(logged).not.toContain("mcp-env-secret");
  expect(logged).not.toContain("sk-model-provider-secret");
  expect(logged).not.toContain("/Applications");
});

test("the default Codex account, whose home is the tool source, starts unchanged", async () => {
  await writeFile(join(codexHome, "config.toml"), personConfig);
  const h = harness("codex");
  await h.open({ instanceHomeDir: codexHome });
  expect(h.opened[0]?.toolConfigArgs).toBeUndefined();
});

test("a chosen tool folder is used instead of the default Codex home", async () => {
  const tools = join(root, "tools");
  await mkdir(tools);
  await writeFile(join(tools, "config.toml"), '[plugins."chrome@x"]\nenabled = true\n');
  const h = harness("codex", { "providers.codex.toolSource": tools });
  await h.open({ instanceHomeDir: codexHome });
  expect(readBack(h.opened[0]?.toolConfigArgs)).toEqual({
    plugins: { "chrome@x": { enabled: true } },
  });
});

test("a tool folder without config.toml starts Codex without it and logs why", async () => {
  const h = harness("codex", { "providers.codex.toolSource": join(root, "nowhere") });
  await h.open({ instanceHomeDir: managed });
  expect(h.opened[0]?.toolConfigArgs).toBeUndefined();
  expect(h.logs.join("\n")).toContain("The Codex tool folder doesn't exist");
});

test("malformed TOML in the tool source starts Codex without it", async () => {
  await writeFile(join(codexHome, "config.toml"), "[plugins\n");
  const h = harness("codex");
  await h.open({ instanceHomeDir: managed });
  expect(h.opened).toHaveLength(1);
  expect(h.opened[0]?.toolConfigArgs).toBeUndefined();
});

test.each([
  ["auto", '{"claudeInChromeDefaultEnabled":true}', true],
  ["auto", '{"claudeInChromeDefaultEnabled":false}', undefined],
  ["auto", undefined, undefined],
  ["auto", "not json", undefined],
  ["on", undefined, true],
  ["off", '{"claudeInChromeDefaultEnabled":true}', false],
])("Claude with Chrome %s and config %s starts with chrome %s", async (setting, config, chrome) => {
  if (config !== undefined) await writeFile(join(home, ".claude.json"), config);
  else await mkdir(home, { recursive: true });
  const h = harness("claude", { "providers.claude.chrome": setting });
  await h.open();
  expect(h.opened[0]?.chrome).toBe(chrome);
});

test("the Codex row reports a managed account's tools from the person's setup", async () => {
  await writeFile(
    join(codexHome, "config.toml"),
    personConfig.replace("/Applications/Host.app/node_repl", join(root, "node_repl")),
  );
  await writeFile(join(root, "node_repl"), "");
  const status = await codexToolStatus({
    setting: null,
    env: { HOME: home },
    homeDir: managed,
    files: cachedToolFiles(nodeFileSystem),
  });
  expect(status.toolSource).toEqual({ path: codexHome, usable: true });
  expect(status.nativeTools.map((tool) => [tool.id, tool.state])).toEqual([
    ["computer-use", "ready"],
    ["chrome", "unavailable"],
    ["browser", "unavailable"],
  ]);
});
