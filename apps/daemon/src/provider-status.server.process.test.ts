import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { createLogger } from "@ace/diagnostics";
import { startProviderStatuses } from "./services/provider-status.ts";
import { Resources } from "./services/resources.ts";
import { readConfig } from "./config.ts";
import type { ServiceContext } from "./services/types.ts";
import { ProviderStatuses } from "./provider-status.ts";
import { fixture } from "./socket-test-support.ts";

async function fakeCli(
  root: string,
  name: string,
  version: string,
  auth: string,
  args: string,
  authExit = 0,
) {
  return nodeBinary(
    root,
    name,
    `
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args !== '--version' && args !== ${JSON.stringify(args)}) { process.stderr.write('UNSAFE COMMAND'); process.exit(90); }
fs.appendFileSync(${JSON.stringify(join(root, "calls"))}, ${JSON.stringify(name)} + ':' + args + '\\n');
const output = args === '--version' ? ${JSON.stringify(version)} : fs.readFileSync(${JSON.stringify(join(root, `${name}-auth`))}, 'utf8');
process.stdout.write(output);
process.exit(args === '--version' ? 0 : ${authExit});
`,
  ).then(async (path) => {
    await writeFile(join(root, `${name}-auth`), auth);
    return path;
  });
}

test("provider status reports native installation and sign-in independently of ace accounts and refreshes a cached result", async () => {
  const f = await fixture();
  let statuses: ProviderStatuses | undefined;
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const bin = join(f.home, "bin");
    await mkdir(bin);
    await fakeCli(
      bin,
      "claude",
      "2.1.286",
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "reader@example.com",
        apiKey: "SECRET",
      }),
      "auth status",
    );
    await fakeCli(bin, "codex", "codex-cli 0.159.1", "Not logged in", "login status");
    await fakeCli(
      bin,
      "opencode",
      "opencode v2.0.22",
      '[{"id":"openai","connections":[{"type":"credential","token":"SECRET"}]}]',
      "auth list --standalone --format json",
    );
    await fakeCli(bin, "agent", "2026.09.26-dd393fe", "Logged in as cursor@example.com", "status");
    await fakeCli(
      bin,
      "pi",
      "0.85.1",
      '{"status":"ready","provider":"anthropic","authType":"oauth","credential":"SECRET"}',
      "auth check --provider anthropic --json --no-refresh",
    );
    const piHome = join(f.home, "pi");
    await mkdir(piHome);
    await writeFile(join(piHome, "settings.json"), '{"defaultProvider":"anthropic"}');
    let now = 1000;
    let interval: (() => void) | undefined;
    statuses = new ProviderStatuses(
      {
        env: { PATH: bin, HOME: f.home, PI_CODING_AGENT_DIR: piHome },
        cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "SDK sign-in" }),
      },
      {
        now: () => now,
        schedule(expire) {
          interval = expire;
          return () => {
            interval = undefined;
          };
        },
      },
    );
    server = await fixture({ providerStatuses: statuses });
    const client = await server.connect();
    await client.next();
    const read = async (operation: "list" | "refresh") => {
      client.send({ type: "providers.request", requestId: operation, operation });
      const result = await client.next();
      if (result.type !== "providers.result" || !result.result.ok)
        throw new Error("Expected provider statuses");
      return result.result.providers;
    };
    const rows = await read("refresh");
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude",
          installed: true,
          path: join(bin, "claude"),
          version: "2.1.286",
          auth: "logged_in",
          accountLabel: "reader@example.com",
        }),
        expect.objectContaining({ provider: "codex", installed: true, auth: "logged_out" }),
        expect.objectContaining({
          provider: "opencode",
          auth: "unknown",
          authEvidence: "credentials_configured",
        }),
        expect.objectContaining({
          provider: "cursor",
          runtime: "cli",
          auth: "logged_in",
          accountLabel: "cursor@example.com",
        }),
        expect.objectContaining({ provider: "pi", auth: "logged_in", authDetail: "oauth" }),
        expect.objectContaining({ provider: "antigravity", installed: false, auth: "unknown" }),
        expect.objectContaining({
          provider: "cursor",
          runtime: "cursor-sdk",
          installed: false,
          auth: "unknown",
        }),
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    const calls = await readFile(join(bin, "calls"), "utf8");
    await writeFile(join(bin, "codex-auth"), "Logged in using ChatGPT");
    expect(await read("list")).toEqual(rows);
    expect(await readFile(join(bin, "calls"), "utf8")).toBe(calls);
    expect(await read("refresh")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "codex", auth: "logged_in", authDetail: "ChatGPT" }),
      ]),
    );
    await writeFile(join(bin, "agent-auth"), "Not logged in");
    await writeFile(join(bin, "opencode-auth"), "[]");
    await rm(join(bin, "claude"));
    const loggedOut = await read("refresh");
    expect(
      loggedOut.find((row) => row.provider === "cursor" && row.runtime === "cli"),
    ).toMatchObject({ auth: "logged_out" });
    expect(
      loggedOut.find((row) => row.provider === "cursor" && row.runtime === "cli"),
    ).not.toHaveProperty("accountLabel");
    const absent = loggedOut.find((row) => row.provider === "claude");
    expect(absent).toMatchObject({ installed: false, auth: "unknown" });
    expect(absent).not.toHaveProperty("path");
    expect(absent).not.toHaveProperty("accountLabel");
    expect(loggedOut.find((row) => row.provider === "opencode")).toMatchObject({
      auth: "logged_out",
    });
    await fakeCli(bin, "claude", "2.1.286", "SECRET invalid response", "auth status");
    now += 300001;
    expect((await read("list"))[0]?.stale).toBe(true);
    interval?.();
    await statuses.refresh();
    expect(await read("list")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude",
          auth: "unknown",
          error: "Unrecognized auth status output",
        }),
      ]),
    );
  } finally {
    await server?.close();
    await statuses?.close();
    await f.close();
  }
});

test("cached reads answer while a CLI hangs and bounded probe failures publish unknown auth without raw output", async () => {
  const f = await fixture();
  const bin = join(f.home, "bin");
  await mkdir(bin);
  await nodeBinary(bin, "codex", "setInterval(() => {}, 1000);");
  const statuses = new ProviderStatuses(
    { env: { PATH: bin, HOME: f.home }, timeoutMs: 100 },
    { now: () => 1000, schedule: () => () => {} },
  );
  const server = await fixture({ providerStatuses: statuses });
  try {
    const client = await server.connect();
    await client.next();
    client.send({ type: "providers.request", requestId: "initial", operation: "list" });
    expect(await client.next()).toMatchObject({ type: "providers.result", result: { ok: true } });
    client.send({ type: "providers.request", requestId: "bounded", operation: "refresh" });
    const response = await client.next();
    expect(response).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "codex",
            installed: true,
            auth: "unknown",
            error: expect.stringContaining("timed out"),
          }),
        ]),
      },
    });
  } finally {
    await server.close();
    await statuses.close();
    await f.close();
  }
});

test("SDK discovery reports its own isolated auth status over the socket and never starts a conversation", async () => {
  const f = await fixture();
  const resources = new Resources();
  const log = createLogger({
    now: () => 1000,
    redact: (value) => value,
    sink: { write: async () => {}, close: async () => {} },
  });
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const entry = join(f.home, "sdk-status.mjs");
    const selectedHome = join(f.home, "sdk-instance");
    const sdkRoot = join(f.home, "sdk");
    const helper = join(f.home, "helper");
    await mkdir(sdkRoot);
    await mkdir(helper);
    await mkdir(join(helper, "bin"));
    await writeFile(join(sdkRoot, "package.json"), '{"name":"@cursor/sdk","version":"1.0.35"}');
    await writeFile(
      join(helper, "package.json"),
      '{"name":"@cursor/sdk-darwin-arm64","version":"1.0.35"}',
    );
    for (const binary of ["rg", "cursorsandbox"])
      await writeFile(join(helper, "bin", binary), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      entry,
      `
import { createInterface } from 'node:readline';
import { readFile, appendFile } from 'node:fs/promises';
createInterface({ input: process.stdin }).on('line', async (line) => {
  const request = JSON.parse(line);
  await appendFile(${JSON.stringify(join(f.home, "sdk-calls"))}, request.method + ':' + process.env.HOME + '\\n');
  if (request.method !== 'status') process.exit(90);
  const status = await readFile(${JSON.stringify(join(f.home, "sdk-safe-status"))}, 'utf8');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { status, source: status === 'logged-in' ? 'sdk-store' : 'none' } }) + '\\n');
});
`,
    );
    await writeFile(join(f.home, "sdk-safe-status"), "logged-out");
    const context: ServiceContext = {
      config: readConfig({ ACE_HOME: f.home, ACE_PORT: "0" }, f.home),
      options: {
        providerStatus: { env: { PATH: f.home, HOME: f.home } },
        engine: {
          cursor: {
            instance: { id: "sdk-default", homeDir: selectedHome },
            env: { HOME: f.home },
            entry,
            discovery: {
              platform: "darwin",
              arch: "arm64",
              nodeVersion: "24.0.0",
              resolve: (id) =>
                id === "@cursor/sdk" ? join(sdkRoot, "index.js") : join(helper, "package.json"),
            },
          },
        },
      },
      signal: new AbortController().signal,
      services: {},
      store: f.store,
      resources,
      now: () => 1000,
      id: () => "status",
      log,
      onListen: [],
    };
    startProviderStatuses(context);
    const statuses = context.services.providerStatuses;
    if (!statuses) throw new Error("Provider statuses unavailable");
    server = await fixture({ providerStatuses: statuses });
    const client = await server.connect();
    await client.next();
    client.send({ type: "providers.request", requestId: "out", operation: "refresh" });
    expect(await client.next()).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "cursor",
            runtime: "cursor-sdk",
            installed: true,
            version: "1.0.35",
            auth: "logged_out",
            authDetail: "none",
          }),
        ]),
      },
    });
    await writeFile(join(f.home, "sdk-safe-status"), "logged-in");
    client.send({ type: "providers.request", requestId: "in", operation: "refresh" });
    expect(await client.next()).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "cursor",
            runtime: "cursor-sdk",
            auth: "logged_in",
            authDetail: "sdk-store",
          }),
        ]),
      },
    });
    expect((await readFile(join(f.home, "sdk-calls"), "utf8")).trim().split("\n")).toEqual([
      `status:${join(selectedHome, "user")}`,
      `status:${join(selectedHome, "user")}`,
    ]);
  } finally {
    await server?.close();
    await resources.close();
    await log.close();
    await f.close();
  }
});

test("unsupported Pi status and failing CLI auth commands stay unknown and never invoke interactive login", async () => {
  const f = await fixture();
  let statuses: ProviderStatuses | undefined;
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const bin = join(f.home, "bin");
    await mkdir(bin);
    const piHome = join(f.home, "pi");
    await mkdir(piHome);
    await writeFile(join(piHome, "settings.json"), '{"defaultProvider":"anthropic"}');
    await fakeCli(
      bin,
      "pi",
      "0.84.0",
      "UNSAFE",
      "auth check --provider anthropic --json --no-refresh",
    );
    await fakeCli(
      bin,
      "codex",
      "codex-cli 0.159.1",
      "Logged in using ChatGPT SECRET",
      "login status",
      2,
    );
    await fakeCli(bin, "agy", "agy 1.2.3", "UNSAFE", "");
    statuses = new ProviderStatuses(
      { env: { PATH: bin, HOME: f.home, PI_CODING_AGENT_DIR: piHome } },
      { now: () => 1000, schedule: () => () => {} },
    );
    server = await fixture({ providerStatuses: statuses });
    const client = await server.connect();
    await client.next();
    client.send({ type: "providers.request", requestId: "failure", operation: "refresh" });
    const response = await client.next();
    expect(response).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "pi",
            installed: true,
            auth: "unknown",
            error: "Pi auth status is unsupported for this version",
          }),
          expect.objectContaining({
            provider: "codex",
            installed: true,
            auth: "unknown",
            error: "Authentication probe exited unsuccessfully",
          }),
          expect.objectContaining({
            provider: "antigravity",
            installed: true,
            version: "1.2.3",
            auth: "unknown",
          }),
        ]),
      },
    });
    expect(JSON.stringify(response)).not.toContain("SECRET");
    const calls = (await readFile(join(bin, "calls"), "utf8")).trim().split("\n");
    expect(calls.toSorted()).toEqual([
      "agy:--version",
      "codex:--version",
      "codex:login status",
      "pi:--version",
    ]);
    await rm(join(piHome, "settings.json"));
    client.send({ type: "providers.request", requestId: "missing-settings", operation: "refresh" });
    expect(await client.next()).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "pi",
            auth: "unknown",
            error: "Pi settings or readiness probe unavailable",
          }),
        ]),
      },
    });
  } finally {
    await server?.close();
    await statuses?.close();
    await f.close();
  }
});
