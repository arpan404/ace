import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { codexToolOverrides, parseCodexToolConfig, relocateCodexHome } from "./index.ts";

/*
 * Codex's own `-c` parser is the edge here: it splits keys on `.` without unquoting, which a
 * TOML parser in the test can't stand in for. `codex mcp list --json` only reads config; it
 * starts no session and needs no login.
 */

const run = promisify(execFile);
const codex = await run("codex", ["--version"]).then(
  () => "codex",
  () => undefined,
);

let root: string;
let source: string;
let account: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-codex-overrides-"));
  source = join(root, "source");
  account = join(root, "account");
  await mkdir(source);
  await mkdir(account);
});
afterEach(() => rm(root, { recursive: true, force: true }));

test.skipIf(!codex)(
  "Codex reads the overrides under the source's names, with the account's home and switches",
  async () => {
    const parsed = parseCodexToolConfig(
      `
[mcp_servers.node_repl]
command = "/bin/echo"
args = ["--stdio"]
env = { CODEX_HOME = "${source}", MODE = "x" }
[mcp_servers."ab@c-d_e"]
command = "/bin/cat"
[mcp_servers."a.b@c"]
command = "/bin/cat"
`,
      source,
    );
    if (!parsed.ok) throw new Error(parsed.problem);
    // The account turned node_repl off in ace: that stays in its own config.toml.
    await writeFile(join(account, "config.toml"), "[mcp_servers.node_repl]\nenabled = false\n");
    const home = parseCodexToolConfig("[mcp_servers.node_repl]\nenabled = false\n", account);
    if (!home.ok) throw new Error(home.problem);
    const args = codexToolOverrides(relocateCodexHome(parsed.tables, source, account), home.tables);

    const { stdout } = await run(codex ?? "codex", [...args, "mcp", "list", "--json"], {
      env: { ...process.env, CODEX_HOME: account, HOME: root },
      timeout: 20_000,
    });
    const servers: { name: string; enabled: boolean; transport: { env: unknown } }[] =
      JSON.parse(stdout);
    expect(servers.map((server) => server.name).toSorted()).toEqual(["ab@c-d_e", "node_repl"]);
    const repl = servers.find((server) => server.name === "node_repl");
    expect(repl?.enabled).toBe(false);
    expect(repl?.transport.env).toEqual({ CODEX_HOME: account, MODE: "x" });
    expect(parsed.skipped).toEqual(["mcp_servers.a.b@c"]);
  },
  30_000,
);
