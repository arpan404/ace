import { describe, expect, test } from "vitest";
import { parseCodexToolConfig, type CodexToolSource } from "@ace/plugins";
import { codexNativeTools, codexToolLaunch, effectiveCodexTools, nodeRepl } from "./codex.ts";

const source = "/Users/me/.codex";
const managed = "/Users/me/.ace/account-homes/work";

function parsed(text: string, dir = source): CodexToolSource {
  return parseCodexToolConfig(text, dir);
}

const allPlugins = `
[plugins."computer-use@bundled"]
enabled = true
[plugins."chrome@bundled"]
enabled = true
[plugins."browser@bundled"]
enabled = true
[mcp_servers.node_repl]
command = "/Applications/Host.app/node_repl"
`;

function states(text: string, facts: Partial<Parameters<typeof codexNativeTools>[0]> = {}) {
  const config = parsed(text);
  const tables = effectiveCodexTools(config, source, config);
  return Object.fromEntries(
    codexNativeTools({ tables, program: "found", inAppBrowserPipe: false, ...facts }).map(
      (tool) => [tool.id, [tool.state, tool.reason]],
    ),
  );
}

describe("Codex launches", () => {
  test("an account whose home is the tool source starts with nothing extra", () => {
    expect(codexToolLaunch(parsed(allPlugins), `${source}/`)).toEqual({ args: [], entries: [] });
  });

  test("a managed account starts with the source's entries", () => {
    const launch = codexToolLaunch(parsed(allPlugins), managed);
    expect(launch.entries).toEqual([
      "plugins.computer-use@bundled",
      "plugins.chrome@bundled",
      "plugins.browser@bundled",
      "mcp_servers.node_repl",
    ]);
    expect(launch.args.filter((arg) => arg === "-c")).toHaveLength(4);
  });

  test("an unusable source adds nothing and says why", () => {
    expect(codexToolLaunch({ ok: false, dir: source, problem: "missing_config" }, managed)).toEqual(
      { args: [], entries: [], problem: "The Codex tool folder has no config.toml" },
    );
  });

  test("the source's entries replace the account's own, which otherwise stay", () => {
    const home = parsed(
      '[plugins."chrome@bundled"]\nenabled = false\n[plugins."mine@local"]\nenabled = true\n',
      managed,
    );
    const tables = effectiveCodexTools(parsed(allPlugins), managed, home);
    expect(tables.plugins["chrome@bundled"]).toEqual({ enabled: true });
    expect(tables.plugins["mine@local"]).toEqual({ enabled: true });
  });
});

describe("Codex tool status", () => {
  test("enabled plugins with node_repl's program found are ready, except the in-app browser", () => {
    expect(states(allPlugins)).toEqual({
      "computer-use": ["ready", undefined],
      chrome: ["ready", undefined],
      browser: ["unavailable", "Needs the ChatGPT app; Chrome and ace's browser still work"],
    });
  });

  test("the in-app browser is ready only with the ChatGPT app's pipe", () => {
    expect(states(allPlugins, { inAppBrowserPipe: true })["browser"]).toEqual(["ready", undefined]);
  });

  test("unified computer use counts as computer use", () => {
    const text =
      '[plugins."unified-computer-use@bundled"]\nenabled = true\n[mcp_servers.node_repl]\ncommand = "/x"\n';
    expect(states(text)["computer-use"]).toEqual(["ready", undefined]);
  });

  test.each([
    [
      "a plugin turned off",
      allPlugins.replace("enabled = true", "enabled = false"),
      {},
      "computer-use",
      "Not turned on in Codex",
    ],
    [
      "no node_repl server",
      allPlugins.split("[mcp_servers")[0] ?? "",
      {},
      "chrome",
      "Codex's node_repl tool server isn't set up",
    ],
    [
      "node_repl turned off",
      `${allPlugins}enabled = false\n`,
      {},
      "chrome",
      "Codex's node_repl tool server is turned off",
    ],
    [
      "node_repl's program missing",
      allPlugins,
      { program: "not_found" as const },
      "computer-use",
      "node_repl's program wasn't found",
    ],
  ])("%s makes the tool unavailable", (_, text, facts, id, reason) => {
    expect(states(text, facts)[id]).toEqual(["unavailable", reason]);
  });

  test("a bare node_repl command can't be checked, so the tool is unknown", () => {
    expect(states(allPlugins, { program: "unchecked" })["chrome"]).toEqual([
      "unknown",
      "ace can't check node_repl's program",
    ]);
  });

  test("an unusable source is the reason a plugin is missing", () => {
    const tables = effectiveCodexTools(
      { ok: false, dir: source, problem: "malformed_config" },
      managed,
      parsed("", managed),
    );
    const tools = codexNativeTools({
      tables,
      program: "none",
      inAppBrowserPipe: false,
      sourceProblem: "config.toml in the Codex tool folder doesn't parse",
    });
    expect(tools.map((tool) => tool.reason)).toEqual([
      "config.toml in the Codex tool folder doesn't parse",
      "config.toml in the Codex tool folder doesn't parse",
      "config.toml in the Codex tool folder doesn't parse",
    ]);
  });

  test("node_repl without a command counts as not set up", () => {
    const config = parsed("[mcp_servers.node_repl]\nargs = []\n");
    expect(nodeRepl(effectiveCodexTools(config, source, config))).toEqual({ state: "missing" });
  });
});
