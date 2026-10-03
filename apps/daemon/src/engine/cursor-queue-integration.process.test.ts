import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Command, ThreadId, type CommandPayload } from "@ace/protocol";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { cursorCapabilities } from "@ace/adapter-cursor";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { scriptFrames, start, end } from "./test-support.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cursor-queue-integration-"));
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Workspace");
  const frames = scriptFrames();
  const adapter = createScriptedAdapter({
    provider: "cursor",
    nativeSessionId: "native-sdk",
    capabilities: cursorCapabilities,
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [
      { on: "send", frames: [frames.frame(start)] },
      { on: "send", frames: [frames.frame(end)] },
    ],
  });
  const registry = new AdapterRegistry();
  registry.register(
    { ...adapter, backend: "cursor-sdk" },
    {
      installed: false,
      auth: "logged_in",
      loginHint: "Offline SDK boundary",
    },
  );
  let migrationReached = false;
  const engine = new Engine(store, {
    registry,
    selectInstance: () => "default-account",
    recovery: {
      async migrate() {
        migrationReached = true;
        throw new Error("No SDK store migration");
      },
    },
  });
  let sequence = 0;
  const command = (payload: CommandPayload) =>
    engine.handler.handle(
      Command.parse({
        id: `integration-${++sequence}`,
        deviceId: "client",
        payload,
      }),
      store,
    );
  return {
    store,
    engine,
    adapter,
    workspaceId,
    command,
    migrationReached: () => migrationReached,
    async close() {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("prepared SDK threads pin the agent-control account without dispatch and refuse conflicting account selectors", async () => {
  const h = await fixture();
  try {
    const id = ThreadId.parse("prepared-sdk");
    expect(
      h.command({
        type: "thread.prepare",
        title: "Prepared SDK",
        threadId: id,
        workspaceId: h.workspaceId,
        provider: "cursor",
        accountId: "delegated-account",
        model: "composer-2.5",
      }),
    ).toMatchObject({ ok: true, threadId: id });
    await h.engine.flush();
    expect(h.engine.sessionMetadata(id)).toMatchObject({
      backend: "cursor-sdk",
      instanceId: "delegated-account",
      model: "composer-2.5",
    });
    expect(h.adapter.sessions).toHaveLength(0);
    expect(
      h.command({
        type: "thread.create",
        workspaceId: h.workspaceId,
        provider: "cursor",
        instanceId: "account-a",
        accountId: "account-b",
        input: [{ type: "text", text: "offline" }],
      }),
    ).toMatchObject({ ok: false, error: "conflicting_account_selection" });
    expect(h.store.listThreads()).toHaveLength(1);
  } finally {
    await h.close();
  }
});

it("queue migration refuses SDK checkpoint copying before closing a live session or changing its account", async () => {
  const h = await fixture();
  try {
    const result = h.command({
      type: "thread.create",
      workspaceId: h.workspaceId,
      provider: "cursor",
      accountId: "account-a",
      input: [{ type: "text", text: "offline" }],
    });
    if (!result.threadId) throw new Error("Missing accepted thread");
    await h.engine.flush();
    expect(h.store.getThread(result.threadId)?.status.state).toBe("working");
    const before = h.engine.queue(result.threadId);
    expect(
      h.command({
        type: "thread.limit",
        threadId: result.threadId,
        expectedRevision: before.revision,
        action: "migrate_now",
        instanceId: "account-b",
      }),
    ).toMatchObject({ ok: false, error: "sdk_account_migration_unsupported" });
    await h.engine.flush();
    expect(h.migrationReached()).toBe(false);
    expect(h.engine.sessionMetadata(result.threadId)).toMatchObject({
      backend: "cursor-sdk",
      instanceId: "account-a",
      nativeSessionId: "native-sdk",
    });
    expect(h.engine.queue(result.threadId)).toEqual(before);
    expect(h.store.getThread(result.threadId)?.status.state).toBe("working");
    expect(
      h.command({
        type: "thread.send",
        threadId: result.threadId,
        delivery: "steer",
        input: [{ type: "text", text: "finish offline" }],
      }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.store.getThread(result.threadId)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});
