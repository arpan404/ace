import { createScriptedAdapter } from "@ace/adapter-testkit";
import { start, end } from "../engine/test-support.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AccountRegistry,
  antigravityIdentity,
  createAntigravityInstance,
  createInstance,
  createAcpInstance,
  createManagedAcpInstance,
} from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { setup } from "./test-support.ts";
import { AgentControlOperation, type ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "./tools.ts";
import { scriptedModelInstance, seedScriptedModels } from "../testing/models.ts";
import { refreshAcpAgentAuth } from "../acp-agent-status.ts";
import { providerFacts } from "./provider-facts.ts";

test("explicit exhausted or mismatched accounts are rejected without creating children and eligible accounts are retained", async () => {
  const db = new DatabaseSync(":memory:"),
    accounts = new AccountRegistry(db);
  const h = setup({}, undefined, false, undefined, false, accounts);
  try {
    await accounts.register(
      createInstance({
        id: "claude-quota",
        provider: "claude",
        label: "Claude",
        homeDir: join(h.home, "claude"),
      }),
    );
    await accounts.register(
      createInstance({
        id: "codex-other",
        provider: "codex",
        label: "Codex",
        homeDir: join(h.home, "codex"),
      }),
    );
    const parent = await h.parent();
    const request = {
      requestId: "quota",
      provider: "claude" as const,
      accountId: "claude-quota",
      task: "work",
      role: "quota-check-task",
      wait: false,
      estimatedLoad: 0,
    };
    accounts.ingest("claude-quota", {
      provider: "claude",
      payload: new ProviderPayload(
        JSON.stringify({
          auth: "logged_in",
          rate_limits: { five_hour: { utilization: 100, resets_at: "1970-01-01T02:00:00Z" } },
        }),
      ),
      observedAt: 1000,
      timeZone: "UTC",
    });
    expect(() => h.service.delegate(parent, request)).toThrow(
      /Claude Code account Claude is at its limit/,
    );
    expect(() =>
      h.service.delegate(parent, { ...request, requestId: "mismatched", accountId: "codex-other" }),
    ).toThrow(/Account codex-other does not belong to Claude Code/);
    expect(h.store.listThreads()).toHaveLength(1);
    // Use a separate eligible native account rather than changing an exhausted assignment.
    await accounts.register(
      createInstance({
        id: "claude-eligible",
        provider: "claude",
        label: "eligible",
        homeDir: join(h.home, "eligible"),
      }),
    );
    accounts.ingest("claude-eligible", {
      provider: "claude",
      payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
      observedAt: 1000,
      timeZone: "UTC",
    });
    h.catalog.registerInstance(scriptedModelInstance("claude", h.home, "claude-eligible"));
    await h.catalog.refresh({ instance: "claude-eligible" });
    const child = h.service.delegate(parent, {
      ...request,
      requestId: "eligible",
      accountId: "claude-eligible",
    });
    await h.engine.flush();
    expect(h.contexts.get(child.childId)?.instanceId).toBe("claude-eligible");
  } finally {
    await h.close();
    db.close();
  }
});

test("an account named by its label runs the work while near its limit, and is refused at it with when", async () => {
  const db = new DatabaseSync(":memory:"),
    accounts = new AccountRegistry(db);
  const h = setup({}, undefined, false, undefined, false, accounts);
  const usage = (utilization: number) =>
    accounts.ingest("claude-346", {
      provider: "claude",
      payload: new ProviderPayload(
        JSON.stringify({
          auth: "logged_in",
          rate_limits: { five_hour: { utilization, resets_at: "1970-01-01T02:00:00Z" } },
        }),
      ),
      observedAt: 1000,
      timeZone: "UTC",
    });
  try {
    await accounts.register(
      createInstance({
        id: "claude-346",
        provider: "claude",
        label: "346",
        homeDir: join(h.home, "346"),
      }),
    );
    h.catalog.registerInstance(scriptedModelInstance("claude", h.home, "claude-346"));
    await h.catalog.refresh({ instance: "claude-346" });
    usage(92);
    const parent = await h.parent();
    const request = {
      requestId: "near",
      provider: "claude" as const,
      accountId: "346",
      task: "work",
      role: "near-limit-task",
      wait: false,
      estimatedLoad: 30,
    };
    const child = h.service.delegate(parent, request);
    await h.engine.flush();
    expect(h.contexts.get(child.childId)?.instanceId).toBe("claude-346");
    usage(100);
    expect(() =>
      h.service.delegate(parent, { ...request, requestId: "full", role: "full-limit-task" }),
    ).toThrow(
      // Worded in the daemon's own time zone: 02:00 UTC there.
      /Claude Code account 346 is at its limit until \d{1,2}:\d{2} [AP]M/,
    );
    expect(() =>
      h.service.delegate(parent, {
        ...request,
        requestId: "nameless",
        role: "nameless-task",
        accountId: "347",
      }),
    ).toThrow('No Claude Code account has "347" as its id or label');
  } finally {
    await h.close();
    db.close();
  }
});

test("legacy Cursor delegation account references select the SDK catalog and remain idempotent", async () => {
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountRegistry(db);
  const h = setup({}, undefined, false, undefined, false, accounts);
  try {
    await accounts.register(
      createInstance({
        id: "cursor-sdk-default",
        provider: "cursor",
        label: "Cursor",
        homeDir: join(h.home, "sdk"),
      }),
    );
    accounts.ingest("cursor-sdk-default", {
      provider: "cursor",
      payload: new ProviderPayload('{"auth":"logged_in"}'),
      observedAt: 1000,
      timeZone: "UTC",
    });
    const cursorModes = nativePermissionModes("cursor");
    const base = h.registry.get("codex").capabilities;
    const adapter = createScriptedAdapter({
      provider: "cursor",
      // The child inherits Cursor's sandboxed mode under its full-access parent.
      capabilities: {
        ...base,
        permissionModes: cursorModes,
        ...(base.permissions
          ? {
              permissions: {
                ...base.permissions,
                permissionModes: cursorModes,
                modes: cursorModes.map((mode) => mode.id),
              },
            }
          : {}),
      },
      nativeSessionId: "sdk-native",
      createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
      steps: [{ on: "send", frames: [h.frames.frame(start, end)] }],
    });
    h.registry.register(
      {
        ...adapter,
        backend: "cursor-sdk",
        async openSession(context) {
          h.contexts.set(context.threadId, context);
          return adapter.openSession(context);
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    h.catalog.registerInstance(scriptedModelInstance("cursor", h.home, "cursor-sdk-default"));
    const parent = await h.parent();
    const request = {
      requestId: "legacy-cursor",
      provider: "cursor" as const,
      accountId: "cursor-cli-default",
      task: "work",
      role: "legacy-cursor-check",
      wait: false,
      estimatedLoad: 0,
    };
    await h.service.prepareModels(parent, request);
    const child = h.service.delegate(parent, request);
    await h.engine.flush();
    expect(h.store.getThread(child.childId)?.backend).toBe("cursor-sdk");
    expect(h.contexts.get(child.childId)?.instanceId).toBe("cursor-sdk-default");
    h.store.atomic((storeDb) =>
      storeDb
        .prepare(
          "UPDATE delegated_threads SET record=json_set(record,'$.request.accountId','cursor-cli-default') WHERE child_id=?",
        )
        .run(child.childId),
    );
    h.restartOwner();
    expect(h.service.journal.get(child.childId)?.request.accountId).toBe("cursor-sdk-default");
    expect(h.service.prepare(parent, { ...request, accountId: "cursor-sdk-default" }).childId).toBe(
      child.childId,
    );
  } finally {
    await h.close();
    db.close();
  }
});

test("a signed-out default CLI does not block automatic selection of a logged-in managed account", async () => {
  const db = new DatabaseSync(":memory:"),
    accounts = new AccountRegistry(db);
  const h = setup({}, undefined, false, undefined, false, accounts);
  try {
    await accounts.register(
      createInstance({
        id: "managed",
        provider: "claude",
        label: "Managed",
        homeDir: join(h.home, "managed"),
      }),
    );
    accounts.ingest("managed", {
      provider: "claude",
      payload: new ProviderPayload('{"auth":"logged_in"}'),
      observedAt: 1000,
      timeZone: "UTC",
    });
    h.catalog.registerInstance(scriptedModelInstance("claude", h.home, "managed"));
    h.registry.register(h.registry.get("claude").source, {
      installed: true,
      auth: "logged_out",
      loginHint: "synthetic",
    });
    const parent = await h.parent();
    const child = h.delegate(parent, "automatic-account");
    await h.engine.flush();
    expect(h.contexts.get(child.childId)?.instanceId).toBe("managed");
    accounts.ingest("managed", {
      provider: "claude",
      payload: new ProviderPayload('{"auth":"logged_out"}'),
      observedAt: 1001,
      timeZone: "UTC",
    });
    expect(() => h.delegate(parent, "signed-out-account")).toThrow(
      /Claude Code account Managed is signed out/,
    );
    expect(h.store.listThreads()).toHaveLength(2);
  } finally {
    await h.close();
    db.close();
  }
});

test("a child delegated onto an added Antigravity account runs on it; other providers can't borrow it", async () => {
  // Added accounts live in private homes under the daemon's data root.
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "ace-antigravity-delegation-")));
  const work = join(dataDir, "account-homes", "work");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountRegistry(db, dataDir);
  const h = setup({}, undefined, false, undefined, false, accounts);
  try {
    await accounts.register(createAntigravityInstance(h.home));
    await accounts.register(
      createManagedAcpInstance({
        id: "work",
        identity: antigravityIdentity,
        label: "Work",
        homeDir: work,
      }),
    );
    accounts.recordAcpAuth("work", "logged_in", 1000);
    const adapter = createScriptedAdapter({
      provider: "antigravity",
      capabilities: h.registry.get("codex").capabilities,
      nativeSessionId: "antigravity-native",
      createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
      steps: [{ on: "send", frames: [h.frames.frame(start, end)] }],
    });
    h.registry.register(
      {
        ...adapter,
        async openSession(context) {
          h.contexts.set(context.threadId, context);
          return adapter.openSession(context);
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    h.catalog.registerInstance(scriptedModelInstance("antigravity", h.home, "work"));
    const parent = await h.parent();
    const request = {
      requestId: "antigravity-work",
      provider: "antigravity" as const,
      accountId: "work",
      task: "work",
      role: "antigravity-account-check",
      wait: false,
      estimatedLoad: 0,
    };
    await h.service.prepareModels(parent, request);
    const child = h.service.delegate(parent, request);
    await h.engine.flush();
    expect(h.contexts.get(child.childId)?.instanceId).toBe("work");

    await expect(
      h.service.prepareModels(parent, { ...request, requestId: "borrowed", provider: "claude" }),
    ).rejects.toThrow(/does not belong/);
    expect(() =>
      h.service.delegate(parent, { ...request, requestId: "borrowed", provider: "claude" }),
    ).toThrow(/does not belong/);
    accounts.recordAcpAuth("work", "logged_out", 1001);
    expect(() => h.service.delegate(parent, { ...request, requestId: "signed-out" })).toThrow(
      /Antigravity account .* is signed out and this model requires authentication/,
    );
    // At its limit, it is refused naming the other Antigravity account, never another provider.
    h.clock.advance(10_000);
    accounts.recordAcpAuth("work", "logged_in", h.clock.now());
    accounts.ingest("work", {
      provider: "acp",
      observedAt: h.clock.now(),
      timeZone: "UTC",
      payload: new ProviderPayload(
        JSON.stringify({
          usageWindows: { session: { usedPercent: 100, resetsAt: h.clock.now() + 3_600_000 } },
        }),
      ),
    });
    expect(() => h.service.delegate(parent, { ...request, requestId: "exhausted" })).toThrow(
      /Antigravity account Work is at its limit until .*\. Other accounts with usage or unread limits: [^.]*\(antigravity/,
    );
    expect(h.store.listThreads()).toHaveLength(2);
  } finally {
    await h.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an agent names an added Antigravity account by its label and a loose model through delegate", async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "ace-antigravity-label-")));
  const work = join(dataDir, "account-homes", "work");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountRegistry(db, dataDir);
  const h = setup({}, undefined, false, undefined, false, accounts);
  try {
    await accounts.register(createAntigravityInstance(h.home));
    await accounts.register(
      createManagedAcpInstance({
        id: "work",
        identity: antigravityIdentity,
        label: "Studio login",
        homeDir: work,
      }),
    );
    accounts.recordAcpAuth("work", "logged_in", 1000);
    const adapter = createScriptedAdapter({
      provider: "antigravity",
      capabilities: h.registry.get("codex").capabilities,
      nativeSessionId: "antigravity-native",
      createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
      steps: [{ on: "send", frames: [h.frames.frame(start, end)] }],
    });
    h.registry.register(
      {
        ...adapter,
        async openSession(context) {
          h.contexts.set(context.threadId, context);
          return adapter.openSession(context);
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    h.catalog.registerInstance(scriptedModelInstance("antigravity", h.home, "work"));
    const parent = await h.parent();
    const port = createAgentControlPort(h.store, h.service);
    const result = await port.execute(
      parent,
      AgentControlOperation.parse({
        op: "delegate_task",
        tasks: [
          {
            requestId: "antigravity-label",
            task: "work",
            role: "antigravity-label-task",
            accountId: "studio login",
            model: "Scripted Model",
          },
        ],
      }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: true });
    const [childId] = (result.data as { threadIds: ThreadId[] }).threadIds;
    if (!childId) throw new Error("No child started");
    await h.engine.flush();
    expect(h.contexts.get(childId)).toMatchObject({ instanceId: "work", model: "chosen-model" });
  } finally {
    await h.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/** A delegation admitted with no client attached: an automation's agent or another machine. */
test("a delegation to a CLI installed after startup is admitted with no client attached", async () => {
  let installed = false;
  const h = setup(
    {},
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    {
      // Rediscovery finds the CLI once it is installed, as the daemon's discovery would.
      waitForProvider: async (provider) => {
        if (provider !== "opencode" || !installed || h.registry.has("opencode")) return;
        const adapter = createScriptedAdapter({
          provider: "opencode",
          capabilities: h.registry.get("codex").capabilities,
          createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
          steps: [{ on: "send", frames: [h.frames.frame(start, end)] }],
        });
        h.registry.register(adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
      },
      refreshProvider: (engine) =>
        providerFacts({
          ensureProvider: (provider) => engine.ensureProvider(provider),
          now: () => h.clock.now(),
          schedule: (run, milliseconds) => h.clock.setTimer(run, milliseconds),
        }),
    },
  );
  h.catalog.registerInstance(scriptedModelInstance("opencode", h.home));
  const parent = await h.parent();
  const request = {
    requestId: "opencode-late",
    provider: "opencode" as const,
    task: "work",
    role: "late-install-check",
    wait: false,
    estimatedLoad: 0,
  };
  await expect(h.service.prepareModels(parent, request)).rejects.toThrow(
    /No installed provider adapter for opencode/,
  );
  // The person installs OpenCode outside ace; nothing else asks about it.
  installed = true;
  await h.service.prepareModels(parent, request);
  const child = h.service.delegate(parent, request);
  await h.engine.flush();
  expect(h.store.getThread(child.childId)).toMatchObject({ provider: "opencode" });
});

const cursorAgent = {
  acpAgentId: "official:cursor",
  installationId: "cursor-install",
  instanceId: "cursor-install:default",
};

/**
 * An ACP account on Cursor's `cursor-agent`, whose own status command reports its login, and the
 * daemon's admission refresh over it. `status` answers each login read; the CLI never runs.
 */
async function cursorAgentDelegations(
  status: (signal: AbortSignal) => Promise<{ isAuthenticated: boolean }>,
) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ace-acp-login-")));
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountRegistry(db, home);
  await accounts.register(
    createAcpInstance({ identity: cursorAgent, label: "Cursor agent", userHome: home }),
  );
  const h = setup(
    {},
    undefined,
    false,
    undefined,
    false,
    accounts,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    {
      refreshProvider: (engine) =>
        providerFacts({
          ensureProvider: (provider) => engine.ensureProvider(provider),
          // As the daemon wires it: this account's own login, read with the admission's signal.
          acpLogin: (instanceId, signal) =>
            refreshAcpAgentAuth({
              registry: accounts,
              installed: [{ metadata: cursorAgent, command: join(home, "cursor-agent") }],
              env: { HOME: home, PATH: "" },
              now: () => h.clock.now(),
              signal,
              only: instanceId,
              probe: async (_command, _args, options) => ({
                code: 0,
                stderr: "",
                stdout: JSON.stringify(await status(options?.signal ?? signal)),
              }),
            }),
          now: () => h.clock.now(),
          schedule: (run, milliseconds) => h.clock.setTimer(run, milliseconds),
        }),
    },
  );
  const adapter = createScriptedAdapter({
    provider: "acp",
    capabilities: h.registry.get("claude").capabilities,
    createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [h.frames.frame(start, end)] }],
  });
  h.registry.register(
    { ...adapter, acceptsIdentity: (selected) => selected.installationId === "cursor-install" },
    { installed: true, auth: "unknown", loginHint: "unused" },
  );
  await seedScriptedModels(h.catalog, {
    ...scriptedModelInstance("acp", h.home, "acp-cursor-catalog"),
    ...cursorAgent,
  });
  const request = {
    requestId: "acp-login",
    provider: "acp" as const,
    ...cursorAgent,
    accountId: cursorAgent.instanceId,
    task: "work",
    role: "acp-login-check",
    wait: false,
    estimatedLoad: 0,
  };
  return {
    h,
    accounts,
    request,
    async close() {
      await h.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a delegation to an ACP agent signed in again outside ace is admitted with no client attached", async () => {
  let signedIn = false;
  const f = await cursorAgentDelegations(async () => ({ isAuthenticated: signedIn }));
  try {
    f.accounts.recordAcpAuth(cursorAgent.instanceId, "logged_out", f.h.clock.now());
    const parent = await f.h.parent();
    // The person signs the agent in in a terminal, and later an automation delegates to it.
    signedIn = true;
    await f.h.service.prepareModels(parent, f.request);
    const child = f.h.service.delegate(parent, f.request);
    await f.h.engine.flush();
    expect(f.h.store.getThread(child.childId)).toMatchObject({ provider: "acp", ...cursorAgent });
  } finally {
    await f.close();
  }
});

test("a slow login read never holds up another provider's delegation, and stops at its deadline", async () => {
  const reads: AbortSignal[] = [];
  // The agent's status command hangs until it is stopped.
  const f = await cursorAgentDelegations(
    (signal) =>
      new Promise((_resolve, reject) => {
        reads.push(signal);
        signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      }),
  );
  try {
    f.accounts.recordAcpAuth(cursorAgent.instanceId, "logged_in", f.h.clock.now());
    const parent = await f.h.parent();
    let acpAdmitted = false;
    const acp = f.h.service.prepareModels(parent, f.request).then(() => {
      acpAdmitted = true;
    });
    await expect.poll(() => reads.length).toBe(1);
    // A Claude delegation meanwhile reads nothing of Cursor's and is admitted at once.
    const claude = {
      requestId: "claude-meanwhile",
      provider: "claude" as const,
      task: "work",
      role: "claude-meanwhile-check",
      wait: false,
      estimatedLoad: 0,
    };
    await f.h.service.prepareModels(parent, claude);
    f.h.service.delegate(parent, claude);
    expect(acpAdmitted).toBe(false);
    // At the deadline the read stops, and admission goes ahead on the login it already had.
    f.h.clock.advance(f.h.clock.now() + 3_000);
    await acp;
    expect(reads[0]?.aborted).toBe(true);
    const child = f.h.service.delegate(parent, f.request);
    await f.h.engine.flush();
    expect(f.h.store.getThread(child.childId)).toMatchObject({ provider: "acp" });
  } finally {
    await f.close();
  }
});
