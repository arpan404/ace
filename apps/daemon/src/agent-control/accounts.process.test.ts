import { createScriptedAdapter } from "@ace/adapter-testkit";
import { start, end } from "../engine/test-support.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AccountRegistry, createInstance } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { setup } from "./test-support.ts";
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
      role: "worker",
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
    const adapter = createScriptedAdapter({
      provider: "cursor",
      capabilities: h.registry.get("codex").capabilities,
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
      role: "worker",
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
