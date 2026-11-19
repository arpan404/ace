import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  codexToolEntryNames,
  codexToolOverrides,
  parseCodexToolConfig,
  readCodexToolSource,
  relocateCodexHome,
  type CodexToolTables,
} from "./index.ts";
import { readCodexOverrides } from "./testing/codex-config.ts";

const source = "/Users/me/tools";

const config = `
model = "gpt-6"
[model_providers.private]
api_key = "sk-model-provider-secret"

[marketplaces.bundled]
source_type = "local"
source = "/opt/codex/bundled"

[marketplaces.mine]
source_type = "local"
source = "marketplaces/mine"

[marketplaces.remote]
source_type = "git"
source = "https://example.com/plugins.git"
last_updated = 2026-11-01T10:00:00Z

[plugins."computer-use@bundled"]
enabled = true

[plugins."chrome@bundled"]
enabled = false

[mcp_servers.node_repl]
command = "/Applications/Host.app/node_repl"
args = ["--stdio"]
env = { TOKEN = "mcp-env-secret" }
`;

function tables(text: string): CodexToolTables {
  const parsed = parseCodexToolConfig(text, source);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.tables;
}

/** What Codex reads back from the overrides, parsing their keys its own way. */
const readBack = (args: readonly string[]) => readCodexOverrides(args);

describe("Codex tool source overrides", () => {
  test("carry marketplaces, plugins and MCP servers as the person wrote them", () => {
    const back = readBack(codexToolOverrides(tables(config)));
    expect(back["plugins"]).toEqual({
      "computer-use@bundled": { enabled: true },
      "chrome@bundled": { enabled: false },
    });
    expect(back["mcp_servers"]).toEqual({
      node_repl: {
        command: "/Applications/Host.app/node_repl",
        args: ["--stdio"],
        env: { TOKEN: "mcp-env-secret" },
      },
    });
    expect(back["marketplaces"]).toMatchObject({
      bundled: { source_type: "local", source: "/opt/codex/bundled" },
      remote: { source_type: "git", source: "https://example.com/plugins.git" },
    });
  });

  test("never carry the rest of the config, model providers included", () => {
    const back = readBack(codexToolOverrides(tables(config)));
    expect(Object.keys(back).toSorted()).toEqual(["marketplaces", "mcp_servers", "plugins"]);
    expect(codexToolOverrides(tables(config)).join(" ")).not.toContain("sk-model-provider-secret");
  });

  test.each([
    [
      "relative local path",
      'source_type = "local"\nsource = "marketplaces/mine"',
      resolve(source, "marketplaces/mine"),
    ],
    [
      "parent-relative path",
      'source_type = "local"\nsource = "../shared"',
      resolve(source, "../shared"),
    ],
    ["no source type means local", 'source = "./mine"', resolve(source, "mine")],
    ["absolute local path", 'source_type = "local"\nsource = "/opt/x"', "/opt/x"],
    ["git URL", 'source_type = "git"\nsource = "plugins.git"', "plugins.git"],
    ["URL and no type", 'source = "https://example.com/p.git"', "https://example.com/p.git"],
    [
      "user@host form and no type",
      'source = "git@example.com:me/p.git"',
      "git@example.com:me/p.git",
    ],
    ["home path and no type", 'source = "~/plugins"', "~/plugins"],
  ])(
    "a marketplace with a %s resolves against the source folder only when local",
    (_, body, expected) => {
      const back = readBack(codexToolOverrides(tables(`[marketplaces.m]\n${body}\n`)));
      expect(back["marketplaces"]).toMatchObject({ m: { source: expected } });
    },
  );

  test("a TOML date stays readable as text instead of losing its marketplace", () => {
    const back = readBack(codexToolOverrides(tables(config)));
    expect(back["marketplaces"]).toMatchObject({
      remote: { last_updated: "2026-11-01T10:00:00.000Z" },
    });
  });

  test.each([
    ["no tool tables", 'model = "gpt-6"\n'],
    ["an empty file", ""],
  ])("a config with %s adds nothing", (_, text) => {
    expect(codexToolOverrides(tables(text))).toEqual([]);
  });

  test("an entry that isn't a table is left out and named, the rest still pass", () => {
    const parsed = parseCodexToolConfig(
      'plugins = 3\n[mcp_servers]\nbroken = "x"\n[mcp_servers.ok]\ncommand = "/bin/ok"\n',
      source,
    );
    expect(parsed.ok && parsed.skipped).toEqual(["plugins", "mcp_servers.broken"]);
    expect(parsed.ok && readBack(codexToolOverrides(parsed.tables))).toEqual({
      mcp_servers: { ok: { command: "/bin/ok" } },
    });
  });

  test.each([
    ["a dot", '[plugins."a.b@c"]\nenabled = true\n', "plugins.a.b@c"],
    ["an equals sign", '[mcp_servers."a=b"]\ncommand = "/x"\n', "mcp_servers.a=b"],
    ["a space", '[mcp_servers."a b"]\ncommand = "/x"\n', "mcp_servers.a b"],
    ["a quote", `[mcp_servers.'a"b']\ncommand = "/x"\n`, 'mcp_servers.a"b'],
  ])("an entry named with %s is left out and named: Codex can't address it", (_, text, name) => {
    const parsed = parseCodexToolConfig(text, source);
    expect(parsed.ok && parsed.skipped).toEqual([name]);
    expect(parsed.ok && codexToolOverrides(parsed.tables)).toEqual([]);
  });

  test("a field Codex can't address is left out while the rest of its entry passes", () => {
    const parsed = parseCodexToolConfig(
      '[mcp_servers.ok]\ncommand = "/x"\n"odd.field" = 1\n',
      source,
    );
    expect(parsed.ok && parsed.skipped).toEqual(["mcp_servers.ok.odd.field"]);
    expect(parsed.ok && readBack(codexToolOverrides(parsed.tables))).toEqual({
      mcp_servers: { ok: { command: "/x" } },
    });
  });

  test("the account's own enabled choice survives the source's", () => {
    const home = tables("[mcp_servers.node_repl]\nenabled = false\n");
    const back = readCodexOverrides(codexToolOverrides(tables(config), home), {
      mcp_servers: { node_repl: { enabled: false } },
    });
    expect(back["mcp_servers"]).toMatchObject({
      node_repl: { enabled: false, command: "/Applications/Host.app/node_repl" },
    });
  });

  test("the source's enabled choice applies where the account sets none", () => {
    const home = tables('[mcp_servers.node_repl]\ncommand = "/mine"\n');
    const back = readCodexOverrides(codexToolOverrides(tables(config), home));
    expect(back["plugins"]).toMatchObject({ "chrome@bundled": { enabled: false } });
  });

  test("malformed TOML is reported, not thrown", () => {
    expect(parseCodexToolConfig("[plugins\nenabled = ", source)).toEqual({
      ok: false,
      dir: source,
      problem: "malformed_config",
    });
  });

  test("names for logs list entries and never their values", () => {
    const names = codexToolEntryNames(tables(config)).join("\n");
    expect(names).toContain("mcp_servers.node_repl");
    expect(names).toContain("plugins.computer-use@bundled");
    expect(names).not.toContain("mcp-env-secret");
    expect(names).not.toContain("/Applications");
  });
});

describe("an MCP server's Codex home", () => {
  const home = "/Users/me/.ace/account-homes/work";
  const relocated = (env: string) =>
    relocateCodexHome(
      tables(`[mcp_servers.node_repl]\ncommand = "/x"\nenv = ${env}\n`),
      source,
      home,
    ).mcp_servers["node_repl"]?.["env"];

  test.each([
    ["CODEX_HOME naming the source", `{ CODEX_HOME = "${source}" }`, { CODEX_HOME: home }],
    ["CODEX_HOME with a trailing slash", `{ CODEX_HOME = "${source}/" }`, { CODEX_HOME: home }],
    ["CODEX_HOME inside the source", `{ CODEX_HOME = "${source}/sub" }`, { CODEX_HOME: home }],
    ["another variable naming the source", `{ ROOT = "${source}" }`, { ROOT: home }],
    [
      "a program inside the source",
      `{ APP = "${source}/computer-use/App.app" }`,
      { APP: `${source}/computer-use/App.app` },
    ],
    ["CODEX_HOME elsewhere", '{ CODEX_HOME = "/elsewhere" }', { CODEX_HOME: "/elsewhere" }],
    ["a sibling folder", `{ CODEX_HOME = "${source}-x" }`, { CODEX_HOME: `${source}-x` }],
  ])("%s is rewritten only when it means the source's home", (_, env, expected) => {
    expect(relocated(env)).toEqual(expected);
  });
});

const enoent = () => Object.assign(new Error("absent"), { code: "ENOENT" });
describe("reading a tool source folder", () => {
  test.each([
    [
      "config.toml is over the size cap",
      true,
      () => Promise.reject(Object.assign(new Error("big"), { code: "EFBIG" })),
      "too_large_config",
    ],
    ["the folder is missing", false, () => Promise.reject(enoent()), "missing_folder"],
    ["config.toml is missing", true, () => Promise.reject(enoent()), "missing_config"],
    [
      "config.toml can't be read",
      true,
      () => Promise.reject(new Error("EACCES")),
      "unreadable_config",
    ],
  ] as const)("says why when %s", async (_, isDirectory, readFile, problem) => {
    const read = await readCodexToolSource(source, {
      isDirectory: async () => isDirectory,
      readFile,
    });
    expect(read).toEqual({ ok: false, dir: source, problem });
  });

  test("reads config.toml inside the folder", async () => {
    const paths: string[] = [];
    const read = await readCodexToolSource(source, {
      isDirectory: async () => true,
      readFile: async (path) => {
        paths.push(path);
        return '[plugins."a@b"]\nenabled = true\n';
      },
    });
    expect(paths).toEqual([join(source, "config.toml")]);
    expect(read.ok && read.tables.plugins).toEqual({ "a@b": { enabled: true } });
  });
});
