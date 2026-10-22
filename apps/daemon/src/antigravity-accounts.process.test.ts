import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
import { ModelCatalog, openModelStorage } from "@ace/models";
import { ThreadId } from "@ace/protocol";
import { AccountManagement } from "./account-management.ts";
import { createManagedHome } from "./account-homes.ts";
import { readConfig } from "./config.ts";
import {
  registerAntigravityAccountCatalog,
  withAntigravityAccounts,
} from "./services/antigravity-accounts.ts";
import { providerAccounts } from "./provider-accounts.ts";
import { prepareAgentLogin } from "./services/provider-login-agent.ts";
import { accountTransitions } from "./services/thread-transitions.ts";
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
  const accounts = new AccountService({ registry, env, now: () => 1000, timeZone: "UTC" });
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }, home),
    options: { accounts: { env }, providerStatus: { env } },
    services: { accountRegistry: registry, accounts },
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
  const adapter = withAntigravityAccounts(
    createAcpAdapter(antigravityQuirks, { command: join(bin, "agy_acp_server"), env }),
    registry,
    accounts,
  );
  return {
    home,
    bin,
    env,
    context,
    registry,
    accounts,
    /** Open a thread's Antigravity session on an account; exits are what its thread hears. */
    open(instanceId?: string, exits: { deliberate: boolean }[] = []) {
      return adapter.openSession({
        threadId: ThreadId.parse("thread-antigravity"),
        cwd: home,
        env,
        ...(instanceId ? { instanceId } : {}),
        signal: new AbortController().signal,
        onFrame() {},
        onExit(exit) {
          exits.push(exit);
        },
      });
    },
    /** Add an Antigravity account the way Settings does: its own home, then registered. */
    async add(label: string) {
      const instance = await createManagedHome(home, `account-${++id}`, "antigravity", label);
      await registry.register(instance);
      return instance;
    },
    /** Remove an account the way Settings asks the daemon to. */
    async remove(instanceId: string) {
      const management = new AccountManagement({
        registry,
        accounts,
        dataDir: home,
        env,
        now: () => 1000,
        id: () => String(++id),
        models: () => undefined,
      });
      try {
        return await providerAccounts(management, sessions, "device", {
          type: "provider.accounts.remove",
          requestId: `request-${++id}`,
          provider: "antigravity",
          instanceId,
          confirm: true,
          deleteHome: false,
        });
      } finally {
        await management.close();
      }
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
    await (await f.open(work.id)).close("shutdown");
    await (await f.open(antigravityIdentity.instanceId)).close("shutdown");
    expect(await f.seen("session/new")).toEqual([
      { home: work.homeDir, fileStore: "true" },
      { home: null, fileStore: null },
    ]);

    f.registry.unregister(work.id);
    await expect(f.open(work.id)).rejects.toThrow(/no longer available/);
    // Never moved onto the CLI login instead.
    expect(await f.seen("session/new")).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("signing an added account in again stops its running thread first, and it can't be removed while one runs", async () => {
  const f = await antigravity();
  try {
    const work = await f.add("Work");
    const exits: { deliberate: boolean }[] = [];
    await f.open(work.id, exits);
    // Removal waits for its threads to finish.
    expect(() => f.accounts.reserveAccountChange(work.id)).toThrow(/busy/);
    expect(await f.signIn(work.id)).toMatchObject({ state: "succeeded" });
    // The thread was told its session ended on purpose before the login changed under it.
    expect(exits).toEqual([expect.objectContaining({ deliberate: true })]);
    expect(() => f.accounts.reserveAccountChange(work.id)).not.toThrow();
  } finally {
    await f.close();
  }
});

test("an added account whose home was swapped for a link elsewhere is never started or signed in there", async () => {
  const f = await antigravity();
  try {
    const work = await f.add("Work");
    const other = join(f.home, "someone-else");
    await mkdir(other);
    await rm(work.homeDir, { recursive: true });
    await symlink(other, work.homeDir);
    await expect(f.open(work.id)).rejects.toThrow();
    expect(await f.signIn(work.id)).toMatchObject({ state: "failed" });
    // The agent never ran in the swapped home.
    expect(await f.seen("session/new").catch(() => [])).toEqual([]);
    expect(await f.seen("authenticate").catch(() => [])).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a thread can switch onto an added Antigravity account, which other providers' threads can't use", async () => {
  const f = await antigravity();
  try {
    const work = await f.add("Work");
    expect(await f.signIn(work.id)).toMatchObject({ state: "succeeded" });
    const transitions = accountTransitions({
      now: () => 1000,
      id: () => "switch",
      services: { accounts: f.accounts, accountRegistry: f.registry },
    });
    expect(transitions.accountProblem?.("antigravity", work.id)).toBeUndefined();
    expect(transitions.accountProblem?.("codex", work.id)).toMatch(/isn't set up/);
  } finally {
    await f.close();
  }
});

test("a signed-in added account's models load in its own home, never with a sign-in, and never in a swapped home", async () => {
  const f = await antigravity();
  const discovered: { home: string | undefined; signInMethod: string | undefined }[] = [];
  const models = new ModelCatalog({
    storage: openModelStorage(join(f.home, "models.sqlite")),
    now: () => 1000,
    deadline: () => () => {},
    discover: async (instance) => {
      discovered.push({ home: instance.env["GEMINI_HOME"], signInMethod: instance.signInMethod });
      return [];
    },
  });
  try {
    const work = await f.add("Work");
    expect(await f.signIn(work.id)).toMatchObject({ state: "succeeded" });
    const context = {
      config: readConfig({ ACE_HOME: f.home, ACE_PORT: "0" }, f.home),
      services: { accountRegistry: f.registry, models },
    };
    const launch = {
      executable: join(f.bin, "agy_acp_server"),
      args: [],
      env: {},
      loginRevision: "1",
    };
    registerAntigravityAccountCatalog(context, work, launch);
    await models.refresh({ instance: work.id });
    // Even though it signed in with a method, discovery is never handed one to sign in again.
    expect(discovered).toEqual([{ home: work.homeDir, signInMethod: undefined }]);

    const other = join(f.home, "someone-else");
    await mkdir(other);
    await rm(work.homeDir, { recursive: true });
    await symlink(other, work.homeDir);
    await models.refresh({ instance: work.id }).catch(() => undefined);
    expect(discovered).toHaveLength(1);
  } finally {
    await models.close();
    await f.close();
  }
});

test("signing an added account in again never hands its model discovery a sign-in", async () => {
  const f = await antigravity();
  const methods: (string | undefined)[] = [];
  const models = new ModelCatalog({
    storage: openModelStorage(join(f.home, "models.sqlite")),
    now: () => 1000,
    deadline: () => () => {},
    discover: async (instance) => {
      if (instance.id !== antigravityIdentity.instanceId) methods.push(instance.signInMethod);
      return [];
    },
  });
  f.context.services.models = models;
  try {
    const work = await f.add("Work");
    expect(await f.signIn(work.id)).toMatchObject({ state: "succeeded" });
    expect(models.hasInstance(work.id)).toBe(true);
    // Signed in with a method again: a lapsed login must still be reported, never reopened.
    expect(await f.signIn(work.id)).toMatchObject({ state: "succeeded" });
    expect(methods.length).toBeGreaterThan(1);
    expect(methods.every((method) => method === undefined)).toBe(true);
  } finally {
    await models.close();
    await f.close();
  }
});

test("removing Antigravity's CLI login is refused before anything signs it out", async () => {
  const f = await antigravity();
  try {
    expect(await f.signIn()).toMatchObject({ state: "succeeded" });
    const requests = (await readFile(join(f.home, "seen.jsonl"), "utf8")).trim().split("\n");
    expect(await f.remove(antigravityIdentity.instanceId)).toMatchObject({
      result: { ok: false, error: "failed" },
    });
    // Still signed in, and the agent was never asked to do anything.
    expect(f.registry.summary(antigravityIdentity.instanceId, 1000)?.quota.auth).toBe("logged_in");
    expect((await readFile(join(f.home, "seen.jsonl"), "utf8")).trim().split("\n")).toEqual(
      requests,
    );
  } finally {
    await f.close();
  }
});

test("signing Antigravity's CLI login in again stops its running threads first", async () => {
  const f = await antigravity();
  try {
    const pinned: { deliberate: boolean }[] = [];
    const unpinned: { deliberate: boolean }[] = [];
    await f.open(antigravityIdentity.instanceId, pinned);
    // A thread that named no account runs on the CLI login too.
    await f.open(undefined, unpinned);
    expect(await f.signIn()).toMatchObject({ state: "succeeded" });
    expect(pinned).toEqual([expect.objectContaining({ deliberate: true })]);
    expect(unpinned).toEqual([expect.objectContaining({ deliberate: true })]);
    // Both kept the person's own environment.
    expect(await f.seen("session/new")).toEqual([
      { home: null, fileStore: null },
      { home: null, fileStore: null },
    ]);
  } finally {
    await f.close();
  }
});
