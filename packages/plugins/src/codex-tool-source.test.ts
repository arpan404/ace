import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  codexToolEntryNames,
  codexToolOverrides,
  parseCodexToolConfig,
  readCodexToolSource,
  type CodexToolTables,
} from "./index.ts";

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

/** What Codex would read back from the overrides: each `-c key=value` parsed as TOML. */
function readBack(args: readonly string[]): Record<string, unknown> {
  const lines: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    expect(args[index]).toBe("-c");
    lines.push(args[index + 1] ?? "");
  }
  return parseToml(lines.join("\n"));
}

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

const enoent = () => Object.assign(new Error("absent"), { code: "ENOENT" });
describe("reading a tool source folder", () => {
  test.each([
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
