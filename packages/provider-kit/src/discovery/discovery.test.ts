import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probeOutput } from "../process.ts";
import { discoverProviders, findExecutable } from "./index.ts";
import { binary, cleanupDirectories, directory, fixture, nodeBinary } from "./testing/cli.ts";

afterEach(cleanupDirectories);
const healthy = {
  version: { stdout: "2.3.4 (Claude Code)", stderr: "", code: 0 },
  auth: { stdout: '{"loggedIn":false}', stderr: "", code: 0 },
};

describe("provider discovery", () => {
  it("reports missing binaries independently without probing installed CLIs", async () => {
    const root = await directory();
    expect(await discoverProviders({ env: { PATH: root } })).toEqual({
      claude: { installed: false, auth: "unknown", loginHint: "claude, then /login" },
      codex: { installed: false, auth: "unknown", loginHint: "codex login" },
      opencode: { installed: false, auth: "unknown", loginHint: "opencode auth login" },
      cursor: { installed: false, auth: "unknown", loginHint: "agent login" },
    });
  });
  it("resolves CLI executables from PATH", async () => {
    const root = await directory();
    const path = await binary(root, "claude", healthy);
    expect((await discoverProviders({ env: { PATH: root } })).claude).toEqual({
      installed: true,
      path,
      version: "2.3.4",
      auth: "logged_out",
      loginHint: "claude, then /login",
    });
  });
  it("discovers a Node CLI when its temporary root is inside an ESM package", async () => {
    const parent = await directory();
    await writeFile(join(parent, "package.json"), '{"type":"module"}');
    const root = await directory(parent);
    const path = await nodeBinary(
      root,
      "codex",
      `const process = require('node:process'); console.log(process.argv[2] === '--version' ? 'codex-cli 4.5.6' : 'Logged in using ChatGPT');`,
    );
    expect((await discoverProviders({ env: { PATH: root } })).codex).toEqual({
      installed: true,
      path,
      version: "4.5.6",
      auth: "logged_in",
      authDetail: "ChatGPT",
      loginHint: "codex login",
    });
  });
  it("prefers explicit overrides and does not fall back when an override is missing", async () => {
    const root = await directory();
    await binary(root, "claude", healthy);
    const override = await binary(root, "custom-claude", {
      version: { stdout: "9.8.7 (Claude Code)", stderr: "", code: 0 },
      auth: { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: "", code: 0 },
    });
    expect(
      (await discoverProviders({ env: { PATH: root }, overrides: { claude: override } })).claude,
    ).toMatchObject({
      installed: true,
      path: override,
      version: "9.8.7",
      auth: "logged_in",
      authDetail: "claude.ai",
    });
    expect(
      (
        await discoverProviders({
          env: { PATH: root },
          overrides: { claude: join(root, "missing") },
        })
      ).claude.installed,
    ).toBe(false);
  });
  it("isolates hanging and failed CLIs while healthy discovery succeeds", async () => {
    const root = await directory();
    await binary(root, "claude", healthy);
    await binary(root, "codex", {
      version: { stdout: "", stderr: "private@example.test sk-synthetic-secret", code: 1 },
      auth: { stdout: "", stderr: "private@example.test sk-synthetic-secret", code: 1 },
    });
    await writeFile(join(root, "opencode"), "#!/bin/sh\nread forever\n", { mode: 0o755 });
    const result = await discoverProviders({ env: { PATH: root }, timeoutMs: 3000 });
    expect(result.claude).toMatchObject({ installed: true, version: "2.3.4", auth: "logged_out" });
    expect(result.codex).toMatchObject({
      installed: true,
      auth: "unknown",
      error: "Version probe exited unsuccessfully; Authentication probe exited unsuccessfully",
    });
    expect(result.opencode).toMatchObject({
      installed: true,
      auth: "unknown",
      error: "Version probe timed out; Authentication probe timed out",
    });
    expect(JSON.stringify(result)).not.toMatch(/private@example\.test|sk-synthetic-secret/);
  }, 15_000);
  it("discovers Codex from captured stderr auth output with empty stdout", async () => {
    const root = await directory();
    const capture = await fixture("codex");
    const path = await binary(root, "codex", capture);
    expect((await discoverProviders({ env: { PATH: root } })).codex).toEqual({
      installed: true,
      path,
      version: "0.159.1",
      auth: "logged_in",
      authDetail: "ChatGPT",
      loginHint: "codex login",
    });
  });
  it("isolates the labelled prior wrapper ENOENT capture without exposing its paths", async () => {
    const root = await directory();
    await binary(root, "codex", await fixture("codex-broken-install"));
    expect((await discoverProviders({ env: { PATH: root } })).codex).toMatchObject({
      installed: true,
      auth: "unknown",
      error: "Version probe exited unsuccessfully; Authentication probe exited unsuccessfully",
    });
  });
  it.each(["non-executable file", "directory"])(
    "skips a %s before a valid PATH binary",
    async (kind) => {
      const first = await directory();
      const second = await directory();
      if (kind === "directory") await mkdir(join(first, "codex"));
      else await writeFile(join(first, "codex"), "not executable", { mode: 0o644 });
      const valid = await binary(second, "codex", await fixture("codex"));
      expect(await findExecutable("codex", { PATH: [first, second].join(delimiter) })).toBe(valid);
    },
  );
  it("chooses the first executable PATH match", async () => {
    const first = await directory();
    const second = await directory();
    const expected = await binary(first, "claude", healthy);
    await binary(second, "claude", healthy);
    expect(await findExecutable("claude", { PATH: [first, second].join(delimiter) })).toBe(
      expected,
    );
  });
  it("doctor JSON and table reflect a CLI's actual version and auth", async () => {
    const root = await directory();
    const cli = fileURLToPath(new URL("../doctor.ts", import.meta.url));
    await binary(root, "codex", {
      version: { stdout: "codex-cli 7.8.9", stderr: "", code: 0 },
      auth: { stdout: "", stderr: "Logged in using ChatGPT", code: 0 },
    });
    const json = await probeOutput(process.execPath, [cli, "--json"], { env: { PATH: root } });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      codex: { installed: true, version: "7.8.9", auth: "logged_in", authDetail: "ChatGPT" },
    });
    const table = await probeOutput(process.execPath, [cli], { env: { PATH: root } });
    expect(table.code).toBe(0);
    for (const text of ["codex", "7.8.9", "logged_in", "ChatGPT"])
      expect(table.stdout).toContain(text);
  }, 15_000);
  it("runs provider probes concurrently so a blocked CLI cannot gate a healthy one", async () => {
    const root = await directory();
    const marker = join(root, "started");
    await nodeBinary(
      root,
      "codex",
      `const fs=require('node:fs'); let done=false; const finish=()=>{if(done)return;done=true;console.log(process.argv[2]==='--version'?'codex-cli 1.2.3':'Logged in using ChatGPT');watcher.close();};const watcher=fs.watch(${JSON.stringify(root)},()=>{if(fs.existsSync(${JSON.stringify(marker)}))finish();});if(fs.existsSync(${JSON.stringify(marker)}))finish();`,
    );
    await nodeBinary(
      root,
      "agent",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');console.log(process.argv[2]==='--version'?'2026.09.26-dd393fe':'Logged in as private@example.test');`,
    );
    const result = await discoverProviders({ env: { PATH: root }, timeoutMs: 10_000 });
    expect(result.codex).toMatchObject({
      installed: true,
      version: "1.2.3",
      auth: "logged_in",
      authDetail: "ChatGPT",
    });
    expect(result.cursor.auth).toBe("logged_in");
  }, 20_000);
});
