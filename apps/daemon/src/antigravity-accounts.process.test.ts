import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AccountService,
  antigravityIdentity,
  createAntigravityInstance,
  openRegistry,
  ProviderLoginSessions,
} from "@ace/accounts";
import { antigravityQuirks, createAcpAdapter } from "@ace/adapter-acp";
import { createLogger } from "@ace/diagnostics";
import { ThreadId } from "@ace/protocol";
import { createManagedHome } from "./account-homes.ts";
import { readConfig } from "./config.ts";
import { withAntigravityAccounts } from "./services/antigravity-accounts.ts";
import { prepareAgentLogin } from "./services/provider-login-agent.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { Store } from "./store.ts";

/**
 * A scripted Antigravity ACP server on PATH: it records, per request, the home its login would
 * live in and whether it was kept off the keychain. No provider, browser or credential.
 */
async function antigravity() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-antigravity-accounts-")));
  const bin = join(home, "bin");
  const seen = join(home, "seen.jsonl");
  await mkdir(bin);
  await writeFile(
    join(bin, "agy_acp_server"),
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
if (process.argv.includes('--version')) { console.log('agy_acp_server 1.4.1'); process.exit(0); }
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({
    method: request.method,
    home: process.env.GEMINI_HOME ?? null,
    fileStore: process.env.AGY_ACP_FORCE_FILE_STORAGE ?? null,
  }) + '\\n');
  const result = request.method === 'initialize'
    ? { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.1' },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }] }
    : request.method === 'session/new' ? { sessionId: 'native' } : {};
  if (request.id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
});
`,
    { mode: 0o700 },
  );
  const env = { HOME: home, PATH: bin };
  const resources = new Resources();
  const registry = await openRegistry(join(home, "accounts.sqlite"), home);
  resources.own(() => registry.close());
  await registry.register(createAntigravityInstance(home));
  const store = new Store(join(home, "events.sqlite"));
  resources.own(() => store.close());
  const log = createLogger({
    now: () => 1000,
    redact: (value) => value,
    sink: { write: async () => {}, close: async () => {} },
  });
  let id = 0;
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }, home),
    options: { accounts: { env }, providerStatus: { env } },
    services: {
      accountRegistry: registry,
      accounts: new AccountService({ registry, env, now: () => 1000, timeZone: "UTC" }),
    },
    resources,
    store,
    now: () => 1000,
    id: () => String(++id),
    log,
    signal: new AbortController().signal,
    onListen: [],
  };
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => `login-${++id}`,
    schedule: () => () => {},
    prepare: (target, action, signal, owner) =>
      prepareAgentLogin(
        context,
        { provider: "antigravity", ...(target.instance ? { instance: target.instance } : {}) },
        action,
        signal,
        owner,
      ),
  });
  return {
    home,
    bin,
    env,
    registry,
    /** Add an Antigravity account the way Settings does: its own home, then registered. */
    async add(label: string) {
      const instance = await createManagedHome(home, `account-${++id}`, "antigravity", label);
      await registry.register(instance);
      return instance;
    },
    async signIn(instance?: string) {
      const result = await sessions.handle("device", {
        type: "provider.login.start",
        requestId: `request-${++id}`,
        provider: "antigravity",
        ...(instance ? { instance } : {}),
      });
      if (!result.result.ok || !("progress" in result.result)) throw new Error("Login rejected");
      return sessions.completed("device", result.result.progress.session);
    },
    async seen(method: string) {
      return (await readFile(seen, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { method: string; home: string | null; fileStore: string | null },
        )
        .filter((entry) => entry.method === method)
        .map(({ home: at, fileStore }) => ({ home: at, fileStore }));
    },
    async close() {
      await sessions.close();
      await resources.close();
      await log.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("an added Antigravity account signs in inside its own home, leaving the CLI login alone", async () => {
  const f = await antigravity();
  try {
    const work = await f.add("Work");
    expect(await f.signIn(work.id)).toMatchObject({ state: "succeeded" });
    expect(await f.seen("authenticate")).toEqual([{ home: work.homeDir, fileStore: "true" }]);
    expect(f.registry.summary(work.id, 1000)).toMatchObject({ quota: { auth: "logged_in" } });
    // The CLI's own login wasn't signed in or out by it.
    expect(f.registry.summary(antigravityIdentity.instanceId, 1000)?.quota.auth).not.toBe(
      "logged_in",
    );

    // Signing in the CLI login runs with the person's own environment, as before.
    expect(await f.signIn()).toMatchObject({ state: "succeeded" });
    expect((await f.seen("authenticate")).at(-1)).toEqual({ home: null, fileStore: null });
  } finally {
    await f.close();
  }
});

test("a thread on an added Antigravity account runs in its home; one whose account is gone is refused", async () => {
  const f = await antigravity();
  try {
    const work = await f.add("Work");
    const adapter = withAntigravityAccounts(
      createAcpAdapter(antigravityQuirks, { command: join(f.bin, "agy_acp_server"), env: f.env }),
      f.registry,
    );
    const open = (instanceId?: string) =>
      adapter.openSession({
        threadId: ThreadId.parse("thread-antigravity"),
        cwd: f.home,
        env: f.env,
        ...(instanceId ? { instanceId } : {}),
        signal: new AbortController().signal,
        onFrame() {},
        onExit() {},
      });

    await (await open(work.id)).close("shutdown");
    await (await open(antigravityIdentity.instanceId)).close("shutdown");
    expect(await f.seen("session/new")).toEqual([
      { home: work.homeDir, fileStore: "true" },
      { home: null, fileStore: null },
    ]);

    f.registry.unregister(work.id);
    await expect(open(work.id)).rejects.toThrow(/no longer available/);
    // Never moved onto the CLI login instead.
    expect(await f.seen("session/new")).toHaveLength(2);
  } finally {
    await f.close();
  }
});
