import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probeOutput } from "../process.ts";
import { discoverProvider, discoverProviders, findExecutable } from "./index.ts";
import { binary, cleanupDirectories, directory, fixture, nodeBinary } from "./testing/cli.ts";

afterEach(cleanupDirectories);
const healthy = {
  version: { stdout: "2.3.4 (Claude Code)", stderr: "", code: 0 },
  auth: { stdout: '{"loggedIn":false}', stderr: "", code: 0 },
};

describe("provider discovery", () => {
  it("OpenCode uses an injected standalone auth probe and cancellation reaches both probes", async () => {
    const root = await directory();
    const path = await binary(root, "opencode", healthy);
    const result = await discoverProvider("opencode", {
      overrides: { opencode: path },
      probe: async (_path, args) => ({
        code: 0,
        stderr: "",
        stdout:
          args[0] === "--version"
            ? "opencode v2.0.22"
            : args.join(" ") === "auth list --standalone --format json"
              ? "[]"
              : "unknown",
      }),
    });
    expect(result).toMatchObject({ installed: true, version: "2.0.22", auth: "logged_out" });
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const cancelled = discoverProvider("opencode", {
      overrides: { opencode: path },
      signal: controller.signal,
      probe: async (_path, args, options) =>
        new Promise((_resolve, reject) => {
          if (args[0] === "--version") entered.resolve();
          const abort = () => reject(options?.signal?.reason);
          options?.signal?.addEventListener("abort", abort, { once: true });
          if (options?.signal?.aborted) abort();
        }),
    });
    const rejected = expect(cancelled).rejects.toThrow("cancelled");
    await entered.promise;
    controller.abort(new Error("cancelled"));
    await rejected;
  });
  it("OpenCode configured connections are recognized without claiming verified authentication", async () => {
    const root = await directory();
    const path = await binary(root, "opencode", healthy);
    const result = await discoverProvider("opencode", {
      overrides: { opencode: path },
      probe: async (_path, args) => ({
        code: 0,
        stderr: "",
        stdout:
          args[0] === "--version"
            ? "opencode v2.0.26"
            : JSON.stringify([{ id: "opencode-go", connections: [{ type: "credential" }] }]),
      }),
    });
    expect(result).toMatchObject({
      installed: true,
      auth: "unknown",
      authEvidence: "credentials_configured",
    });
    expect(result.error).toBeUndefined();
  });
  it("reports missing binaries independently without probing installed CLIs", async () => {
    const root = await directory();
    expect(await discoverProviders({ env: { PATH: root } })).toEqual({
      claude: { installed: false, auth: "unknown", loginHint: "claude, then /login" },
      codex: { installed: false, auth: "unknown", loginHint: "codex login" },
      opencode: { installed: false, auth: "unknown", loginHint: "opencode auth login" },
      cursor: { installed: false, auth: "unknown", loginHint: "Sign in to Cursor" },
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
    expect(result.opencode).toMatchObject({ installed: false, auth: "unknown" });
    expect(JSON.stringify(result)).not.toMatch(/private@example\.test|sk-synthetic-secret/);
  });
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
    const [json, table] = await Promise.all([
      probeOutput(process.execPath, [cli, "--json"], { env: { PATH: root } }),
      probeOutput(process.execPath, [cli], { env: { PATH: root } }),
    ]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      codex: { installed: true, version: "7.8.9", auth: "logged_in", authDetail: "ChatGPT" },
    });
    expect(table.code).toBe(0);
    for (const text of ["codex", "7.8.9", "logged_in", "ChatGPT"])
      expect(table.stdout).toContain(text);
  });
  it("runs provider probes concurrently so a blocked CLI cannot gate a healthy one", async () => {
    const parent = await directory();
    await writeFile(join(parent, "package.json"), JSON.stringify({ type: "module" }));
    const root = await directory(parent);
    const waiting = new Set<Socket>();
    let released = false;
    const gate = createServer((socket) => {
      socket.once("data", (data) => {
        if (data.toString() === "release") {
          released = true;
          for (const blocked of waiting) blocked.end("go");
          waiting.clear();
          socket.end();
        } else if (released) socket.end("go");
        else waiting.add(socket);
      });
      socket.on("close", () => waiting.delete(socket));
    });
    gate.listen(0, "127.0.0.1");
    await once(gate, "listening");
    const address = gate.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const endpoint = JSON.stringify({ port: address.port, host: "127.0.0.1" });
    try {
      await nodeBinary(
        root,
        "codex",
        `const socket=require('node:net').createConnection(${endpoint},()=>socket.write('wait'));socket.once('data',()=>console.log(process.argv[2]==='--version'?'codex-cli 1.2.3':'Logged in using ChatGPT'));`,
      );
      await nodeBinary(
        root,
        "claude",
        `const socket=require('node:net').createConnection(${endpoint},()=>socket.end('release'));console.log(process.argv[2]==='--version'?'1.2.3':'{"loggedIn":false}');`,
      );
      const result = await discoverProviders({ env: { PATH: root }, timeoutMs: 10_000 });
      expect(result.codex).toMatchObject({
        installed: true,
        version: "1.2.3",
        auth: "logged_in",
        authDetail: "ChatGPT",
      });
      expect(result.codex.error).toBeUndefined();
      expect(result.claude).toMatchObject({ version: "1.2.3", auth: "logged_out" });
      expect(result.claude.error).toBeUndefined();
    } finally {
      for (const socket of waiting) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        gate.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

it("OpenCode v1 alone is not installed and a later v2 is selected without probing v1 auth", async () => {
  const root = await directory();
  const later = await directory();
  const old = await binary(root, "opencode", {
    version: { stdout: "1.18.4", stderr: "", code: 0 },
    auth: { stdout: "should not probe auth", stderr: "", code: 1 },
  });
  const env = { PATH: root, HOME: root };
  expect(await discoverProvider("opencode", { env })).toMatchObject({ installed: false });
  const current = await binary(later, "opencode", {
    version: { stdout: "2.0.26", stderr: "", code: 0 },
    auth: { stdout: "[]", stderr: "", code: 0 },
  });
  expect(
    await discoverProvider("opencode", { env: { ...env, PATH: root + delimiter + later } }),
  ).toMatchObject({ installed: true, path: current, version: "2.0.26", auth: "logged_out" });
  expect(
    await discoverProvider("opencode", {
      env: { ...env, PATH: later },
      overrides: { opencode: old },
    }),
  ).toMatchObject({ installed: false });
});
