import { fakeCli } from "./provider-status-test-support.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { ProviderStatuses } from "./provider-status.ts";
import { fixture } from "./socket-test-support.ts";

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
    expect(loggedOut.filter((row) => row.provider === "cursor")).toEqual([
      expect.objectContaining({ runtime: "cursor-sdk", installed: false, auth: "unknown" }),
    ]);
    expect(await readFile(join(bin, "calls"), "utf8")).not.toContain("agent:");
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

test("cached reads answer before a gated CLI status probe is released", async () => {
  const f = await fixture();
  const bin = join(f.home, "bin");
  await mkdir(bin);
  await nodeBinary(bin, "codex", "process.exit(90);");
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const statuses = new ProviderStatuses(
    {
      env: { PATH: bin, HOME: f.home },
      probe: async (_path, args) => {
        if (args[0] === "--version") return { code: 0, stdout: "codex-cli 0.159.1", stderr: "" };
        entered.resolve();
        await release.promise;
        throw new Error("Probe timed out");
      },
    },
    { now: () => 1000, schedule: () => () => {} },
  );
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await entered.promise;
    server = await fixture({ providerStatuses: statuses });
    const client = await server.connect();
    await client.next();
    client.send({ type: "providers.request", requestId: "initial", operation: "list" });
    // This must arrive while the probe still holds the latch, not after its deadline.
    expect(await client.next()).toMatchObject({
      type: "providers.result",
      result: {
        ok: true,
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: "codex", installed: null, refreshing: true }),
        ]),
      },
    });
    release.resolve();
    client.send({ type: "providers.request", requestId: "bounded", operation: "refresh" });
    expect(await client.next()).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "codex",
            installed: true,
            auth: "unknown",
            error: "Authentication probe timed out",
          }),
        ]),
      },
    });
  } finally {
    release.resolve();
    await server?.close();
    await statuses.close();
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
    await fakeCli(bin, "agy_acp_server", "agy 1.2.3", "UNSAFE", "");
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
      "agy_acp_server:--version",
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
            error: "Pi auth status is unsupported for this version",
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

test("oversized optional CLI metadata cannot erase installation or safe authentication", async () => {
  const f = await fixture();
  let statuses: ProviderStatuses | undefined;
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const bin = join(f.home, "bin");
    await mkdir(bin);
    const path = await fakeCli(
      bin,
      "codex",
      `${"1".repeat(300)}.2.3`,
      "Logged in using ChatGPT",
      "login status",
    );
    statuses = new ProviderStatuses(
      { env: { PATH: bin, HOME: f.home } },
      { now: () => 1000, schedule: () => () => {} },
    );
    server = await fixture({ providerStatuses: statuses });
    const client = await server.connect();
    await client.next();
    client.send({ type: "providers.request", requestId: "oversized", operation: "refresh" });
    const response = await client.next();
    expect(response).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "codex",
            installed: true,
            path,
            auth: "logged_in",
            authDetail: "ChatGPT",
            error: "Invalid optional provider metadata",
          }),
        ]),
      },
    });
    expect(JSON.stringify(response)).not.toContain("1".repeat(300));
  } finally {
    await server?.close();
    await statuses?.close();
    await f.close();
  }
});

test("Pi rejects symlinked and FIFO settings without probing auth or exposing their contents", async () => {
  const f = await fixture();
  let statuses: ProviderStatuses | undefined;
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const bin = join(f.home, "bin"),
      piHome = join(f.home, "pi");
    await mkdir(bin);
    await mkdir(piHome);
    await fakeCli(
      bin,
      "pi",
      "0.85.1",
      "UNSAFE",
      "auth check --provider anthropic --json --no-refresh",
    );
    const external = join(f.home, "private-settings");
    await writeFile(external, '{"defaultProvider":"anthropic","token":"SECRET"}');
    await symlink(external, join(piHome, "settings.json"));
    statuses = new ProviderStatuses(
      { env: { PATH: bin, HOME: f.home, PI_CODING_AGENT_DIR: piHome } },
      { now: () => 1000, schedule: () => () => {} },
    );
    server = await fixture({ providerStatuses: statuses });
    const client = await server.connect();
    await client.next();
    for (const kind of ["symlink", "fifo"]) {
      if (kind === "fifo") {
        await rm(join(piHome, "settings.json"));
        await promisify(execFile)("mkfifo", [join(piHome, "settings.json")]);
      }
      client.send({ type: "providers.request", requestId: kind, operation: "refresh" });
      const response = await client.next();
      expect(response).toMatchObject({
        result: {
          providers: expect.arrayContaining([
            expect.objectContaining({
              provider: "pi",
              installed: true,
              auth: "unknown",
              error: "Pi settings or readiness probe unavailable",
            }),
          ]),
        },
      });
      expect(JSON.stringify(response)).not.toContain("SECRET");
    }
    const calls = (await readFile(join(bin, "calls"), "utf8")).trim().split("\n");
    expect(calls.every((line) => line === "pi:--version")).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  } finally {
    await server?.close();
    await statuses?.close();
    await f.close();
  }
});
