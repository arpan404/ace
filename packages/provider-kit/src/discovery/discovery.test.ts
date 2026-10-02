import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probeOutput } from "../process.ts";
import {
  discoverProviders,
  parseClaudeAuth,
  parseCodexAuth,
  parseCursorAuth,
  parseOpenCodeAuth,
  parseVersion,
} from "./index.ts";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "provider-kit-discovery-"));
  directories.push(path);
  return path;
}
async function binary(root: string, name: string, script: string) {
  const path = join(root, name);
  await writeFile(path, `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("provider discovery", () => {
  it("reports this machine's captured auth and versions without identity or credential fields", async () => {
    const expected = {
      claude: { version: "2.1.286", auth: { auth: "logged_in", authDetail: "claude.ai" } },
      codex: { version: undefined, auth: { auth: "unknown" } },
      opencode: {
        version: "1.18.4",
        auth: { auth: "logged_in", authDetail: "GitHub Copilot, OpenCode Go, LMStudio" },
      },
      cursor: { version: "2026.09.26-dd393fe", auth: { auth: "logged_in" } },
    };
    const parsers = {
      claude: parseClaudeAuth,
      codex: parseCodexAuth,
      opencode: parseOpenCodeAuth,
      cursor: parseCursorAuth,
    };
    for (const provider of ["claude", "codex", "opencode", "cursor"] as const) {
      const fixture = JSON.parse(
        await readFile(new URL(`./__fixtures__/${provider}.json`, import.meta.url), "utf8"),
      ) as { version: { stdout: string }; auth: { stdout: string; stderr: string } };
      expect(parseVersion(provider, fixture.version.stdout)).toBe(expected[provider].version);
      expect(parsers[provider](fixture.auth.stdout || fixture.auth.stderr)).toEqual(
        expected[provider].auth,
      );
    }
  });
  it("recognizes logged out outputs and treats unreadable status as unknown", () => {
    expect(parseClaudeAuth('{"loggedIn":false}')).toEqual({ auth: "logged_out" });
    expect(parseCodexAuth("Not logged in")).toEqual({ auth: "logged_out" });
    expect(parseCursorAuth("You are not logged in. Run agent login")).toEqual({
      auth: "logged_out",
    });
    expect(parseOpenCodeAuth("└  0 credentials")).toEqual({ auth: "logged_out" });
    for (const parse of [parseClaudeAuth, parseCodexAuth, parseCursorAuth, parseOpenCodeAuth]) {
      expect(parse("Error: broken CLI")).toEqual({ auth: "unknown" });
      expect(parse("")).toEqual({ auth: "unknown" });
    }
  });
  it("recognizes Codex login methods without exposing the printed API key", () => {
    expect(parseCodexAuth("Logged in using ChatGPT")).toEqual({
      auth: "logged_in",
      authDetail: "ChatGPT",
    });
    expect(parseCodexAuth("Logged in using an API key - sk-synthetic-secret")).toEqual({
      auth: "logged_in",
      authDetail: "API key",
    });
    expect(parseVersion("codex", "codex-cli 0.159.1\n")).toBe("0.159.1");
  });
  it("ignores identity fields and unrecognized auth labels in JSON status", () => {
    expect(
      parseClaudeAuth(
        '{"loggedIn":true,"authMethod":"sk-synthetic-secret","email":"private@example.test","orgName":"private"}',
      ),
    ).toEqual({ auth: "logged_in" });
    expect(
      parseCursorAuth(
        '{"isAuthenticated":true,"userInfo":{"email":"private@example.test"},"accessToken":"synthetic-secret"}',
      ),
    ).toEqual({ auth: "logged_in" });
    expect(parseCursorAuth('{"isAuthenticated":false}')).toEqual({ auth: "logged_out" });
    expect(parseOpenCodeAuth("●  private@example.test api\n└  1 credential")).toEqual({
      auth: "logged_in",
      authDetail: "1 configured credentials",
    });
  });
  it("reports missing binaries independently without probing installed CLIs", async () => {
    const root = await directory();
    const result = await discoverProviders({ env: { PATH: root } });
    expect(result).toEqual({
      claude: { installed: false, auth: "unknown", loginHint: "claude, then /login" },
      codex: { installed: false, auth: "unknown", loginHint: "codex login" },
      opencode: { installed: false, auth: "unknown", loginHint: "opencode auth login" },
      cursor: { installed: false, auth: "unknown", loginHint: "agent login" },
    });
  });
  it("finds PATH executables, prefers explicit overrides and isolates a hanging CLI", async () => {
    const root = await directory();
    await binary(
      root,
      "claude",
      `console.log(process.argv[2] === '--version' ? '2.3.4 (Claude Code)' : '{"loggedIn":false}')`,
    );
    const override = await binary(
      root,
      "custom-claude",
      `console.log(process.argv[2] === '--version' ? '9.8.7 (Claude Code)' : '{"loggedIn":true,"authMethod":"claude.ai"}')`,
    );
    await binary(
      root,
      "codex",
      `process.stderr.write('private@example.test sk-synthetic-secret'); process.exitCode=1`,
    );
    await binary(root, "opencode", `setInterval(() => {}, 1000)`);
    await binary(
      root,
      "agent",
      `console.log(process.argv[2] === '--version' ? '2026.09.26-dd393fe' : 'Logged in as private@example.test')`,
    );
    const results = await discoverProviders({
      overrides: { claude: override },
      env: { PATH: root },
      timeoutMs: 1000,
    });
    expect(results.claude).toEqual({
      installed: true,
      path: override,
      version: "9.8.7",
      auth: "logged_in",
      authDetail: "claude.ai",
      loginHint: "claude, then /login",
    });
    expect(results.cursor).toEqual({
      installed: true,
      path: join(root, "agent"),
      version: "2026.09.26-dd393fe",
      auth: "logged_in",
      loginHint: "agent login",
    });
    expect(results.codex).toMatchObject({
      installed: true,
      auth: "unknown",
      error: "Version probe exited unsuccessfully; Authentication probe exited unsuccessfully",
    });
    expect(results.opencode).toMatchObject({
      installed: true,
      auth: "unknown",
      error: "Version probe timed out; Authentication probe timed out",
    });
    expect(JSON.stringify(results)).not.toContain("private@example.test");
    expect(JSON.stringify(results)).not.toContain("sk-synthetic-secret");
    const fromPath = await discoverProviders({
      env: { PATH: root },
      overrides: { opencode: join(root, "missing") },
      timeoutMs: 1000,
    });
    expect(fromPath.claude).toMatchObject({
      installed: true,
      path: join(root, "claude"),
      version: "2.3.4",
      auth: "logged_out",
    });
    expect(fromPath.opencode.installed).toBe(false);
  });
  it("prints doctor JSON as discovery results and a readable table by default", async () => {
    const root = await directory();
    const cli = fileURLToPath(new URL("../doctor.ts", import.meta.url));
    const json = await probeOutput(process.execPath, [cli, "--json"], { env: { PATH: root } });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      claude: { installed: false, auth: "unknown", loginHint: "claude, then /login" },
      codex: { installed: false, auth: "unknown", loginHint: "codex login" },
      opencode: { installed: false, auth: "unknown", loginHint: "opencode auth login" },
      cursor: { installed: false, auth: "unknown", loginHint: "agent login" },
    });
    const table = await probeOutput(process.execPath, [cli], { env: { PATH: root } });
    expect(table.code).toBe(0);
    for (const text of [
      "claude",
      "codex",
      "opencode",
      "cursor",
      "installed",
      "false",
      "unknown",
      "codex login",
    ])
      expect(table.stdout).toContain(text);
  });
  it("runs provider probes concurrently so a blocked CLI cannot gate a healthy one", async () => {
    const root = await directory();
    const marker = join(root, "started");
    // Codex waits on a real filesystem event produced only by the Cursor probe.
    await binary(
      root,
      "codex",
      `const fs = require('node:fs'); const finish = () => { console.log(process.argv[2] === '--version' ? 'codex-cli 1.2.3' : 'Logged in using ChatGPT'); watcher.close(); }; const watcher = fs.watch(${JSON.stringify(root)}, () => { if(fs.existsSync(${JSON.stringify(marker)})) finish(); }); if(fs.existsSync(${JSON.stringify(marker)})) finish();`,
    );
    await binary(
      root,
      "agent",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); console.log(process.argv[2] === '--version' ? '2026.09.26-dd393fe' : 'Logged in as private@example.test');`,
    );
    const result = await discoverProviders({ env: { PATH: root }, timeoutMs: 2000 });
    expect(result.codex).toMatchObject({
      installed: true,
      version: "1.2.3",
      auth: "logged_in",
      authDetail: "ChatGPT",
    });
    expect(result.cursor.auth).toBe("logged_in");
  });
});
