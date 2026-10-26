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
  createManagedAcpInstance,
} from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { setup } from "./test-support.ts";
import { AgentControlOperation, type ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "./tools.ts";
import { scriptedModelInstance } from "../testing/models.ts";

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
        JSON.stringify({ auth: "logged_in", error: "usage limit reached" }),
      ),
      observedAt: 1000,
      timeZone: "UTC",
    });
    expect(() => h.service.delegate(parent, request)).toThrow(/quota exhausted/);
    expect(() =>
      h.service.delegate(parent, { ...request, requestId: "mismatched", accountId: "codex-other" }),
    ).toThrow(/Account unavailable/);
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
    expect(() => h.delegate(parent, "signed-out-account")).toThrow(/Account unavailable/);
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
    ).toThrow(/Account unavailable/);
    accounts.recordAcpAuth("work", "logged_out", 1001);
    expect(() => h.service.delegate(parent, { ...request, requestId: "signed-out" })).toThrow(
      /requires authentication/,
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
