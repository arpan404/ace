import { createHash } from "node:crypto";
import { z } from "zod";
import { expect, test } from "vitest";
import { Client } from "@ace/client";
import {
  Project,
  DeviceId,
  ProviderKind,
  WorkspaceId,
  ThreadId,
  ServerMessage,
  type ServerMessage as Message,
} from "@ace/protocol";
import {
  ScenarioPlayer,
  flakyCheckout,
  settingsFixture,
  FakeDaemon,
  fakeTransport,
} from "./index.ts";

async function fixture(daemon = new FakeDaemon({ clock: () => 1000 })) {
  let saved: string | null = null,
    sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: {
      async load() {
        return saved;
      },
      async save(value) {
        saved = value;
      },
    },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `read-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  return { daemon, client, saved: () => saved };
}

test("fake service reads leave the durable outbox untouched and new-thread receipts identify one thread", async () => {
  const f = await fixture();
  try {
    const saved = f.saved();
    expect((await f.client.request({ type: "diagnostics.health" })).ok).toBe(true);
    expect(
      (await f.client.request({ type: "settings.get", key: "threads.autoSettleAfter", scope: {} }))
        .entries?.[0]?.key,
    ).toBe("threads.autoSettleAfter");
    expect(f.saved()).toBe(saved);
    const create = {
      type: "thread.create" as const,
      provider: "codex" as const,
      workspaceId: WorkspaceId.parse("workspace"),
      account: "personal",
      model: "model-a",
      options: { reasoning: "high" },
      mode: "worktree" as const,
      baseBranch: "develop",
      input: [{ type: "text" as const, text: "Synthetic" }],
    };
    const first = await f.client.command(create, {}, "create");
    const retry = await f.client.command(create, {}, "create");
    expect(first.threadId).toBe("thread-create");
    expect(retry.threadId).toBe(first.threadId);
    const view = f.daemon.snapshot({
      kind: "thread",
      threadId: first.threadId ?? ThreadId.parse("missing"),
    });
    expect(view).toMatchObject({
      thread: {
        details: { mode: "worktree", baseBranch: "develop" },
        live: { model: "model-a", account: "personal", options: { reasoning: "high" } },
      },
    });
    const list = f.daemon.snapshot({ kind: "threads" });
    if (list?.kind !== "threads") throw new Error("Expected sidebar");
    expect(Object.keys(list.threads)).toEqual([first.threadId]);
  } finally {
    await f.client.close();
  }
});

test("fake terminals use byte offsets and wait for credit before replaying blocked output", async () => {
  const f = await fixture();
  f.daemon.createThread({
    id: "thread",
    workspaceId: "workspace",
    title: "Terminal",
    provider: "codex",
  });
  const threadId = ThreadId.parse("thread");
  const outputs: Message[] = [];
  const stop = f.client.onMessage((message) => {
    if (message.type === "terminal.output") outputs.push(ServerMessage.parse(message));
  });
  try {
    const opened = await f.client.request({
      type: "terminal.request",
      operation: { op: "open", threadId },
    });
    if (!opened.terminal) throw new Error("Expected terminal");
    await f.client.request({
      type: "terminal.request",
      operation: {
        op: "subscribe",
        threadId,
        terminalId: opened.terminal.id,
        subscriptionId: "stream",
      },
    });
    expect(outputs).toHaveLength(1);
    await f.client.request({
      type: "terminal.request",
      operation: { op: "write", threadId, terminalId: opened.terminal.id, data: "echo 雪\r" },
    });
    expect(outputs).toHaveLength(1);
    f.client.send({ type: "terminal.credit", subscriptionId: "stream" });
    await f.client.request({ type: "terminal.request", operation: { op: "list", threadId } });
    expect(outputs).toHaveLength(2);
    const frame = outputs[1];
    if (frame?.type !== "terminal.output" || frame.event.type !== "data")
      throw new Error("Expected replay bytes");
    expect(frame.event.data).toContain("雪");
    expect(frame.event.endOffset - frame.event.offset).toBe(
      new TextEncoder().encode(frame.event.data).length,
    );
    await f.client.request({
      type: "terminal.request",
      operation: { op: "unsubscribe", subscriptionId: "stream" },
    });
  } finally {
    stop();
    await f.client.close();
  }
});

test("fake plugin source edits require a new pinned review and leave accepted source unchanged until acceptance", async () => {
  const f = await fixture();
  try {
    const prepared = await f.client.request({
      type: "pluginRequest",
      request: { type: "plugins.prepare", repository: "fixture", ref: "main", name: "example" },
    });
    if (prepared.response.type !== "plugins.review") throw new Error("Expected review");
    await f.client.request({
      type: "pluginRequest",
      request: {
        type: "plugins.accept",
        id: prepared.response.review.id,
        hash: prepared.response.review.hash,
        commit: prepared.response.review.commit,
      },
    });
    const catalog = await f.client.request({
      type: "pluginRequest",
      request: { type: "plugins.catalog" },
    });
    expect(catalog.response).toMatchObject({
      type: "plugins.catalog",
      components: [
        { plugin: "example", kind: "skill", enabled: true, providers: ProviderKind.options },
      ],
    });
    expect(
      (
        await f.client.request({
          type: "pluginRequest",
          request: {
            type: "plugins.availability",
            name: "example",
            enabled: true,
            providers: ProviderKind.options,
          },
        })
      ).response,
    ).toMatchObject({
      availability: { enabled: true, providers: ProviderKind.options },
    });
    const read = () =>
      f.client.request({
        type: "pluginRequest",
        request: { type: "plugins.source", name: "example", path: "skills/example/SKILL.md" },
      });
    const before = await read();
    if (before.response.type !== "plugins.source") throw new Error("Expected source");
    const edited = await f.client.request({
      type: "pluginRequest",
      request: {
        type: "plugins.edit",
        name: "example",
        path: "skills/example/SKILL.md",
        expectedHash: before.response.hash,
        text: "# Revised skill\n",
      },
    });
    expect((await read()).response).toMatchObject({
      text: before.response.text,
      hash: before.response.hash,
    });
    if (edited.response.type !== "plugins.review") throw new Error("Expected edit review");
    await f.client.request({
      type: "pluginRequest",
      request: {
        type: "plugins.accept",
        id: edited.response.review.id,
        commit: edited.response.review.commit,
        hash: edited.response.review.hash,
      },
    });
    expect((await read()).response).toMatchObject({ text: "# Revised skill\n" });
  } finally {
    await f.client.close();
  }
});

test("fake browser control and preview forwards use real correlated messages and release subscriptions", async () => {
  const f = await fixture();
  f.daemon.createThread({
    id: "thread",
    workspaceId: "workspace",
    title: "Browser",
    provider: "codex",
  });
  const threadId = ThreadId.parse("thread");
  const received: Message[] = [];
  const stop = f.client.onMessage((message) => {
    if (message.type === "browser.state" || message.type === "browser.frame")
      received.push(message);
  });
  try {
    expect(
      (
        await f.client.request({
          type: "browser.open",
          options: { threadId, workspaceId: WorkspaceId.parse("workspace") },
        })
      ).ok,
    ).toBe(true);
    await f.client.request({ type: "browser.subscribe", threadId });
    await f.client.request({ type: "browser.takeover", threadId });
    expect(received).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ controller: "human" }),
      }),
    );
    // A client acts as a person: it navigates while it holds control, and is refused after.
    await f.client.request({
      type: "browser.execute",
      threadId,
      command: { action: "navigate", url: "https://example.com" },
    });
    await f.client.request({ type: "browser.handback", threadId });
    expect(
      await f.client.request({
        type: "browser.execute",
        threadId,
        command: { action: "navigate", url: "https://example.com/later" },
      }),
    ).toMatchObject({ ok: false, error: "Browser controller mismatch" });
    expect(received).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ url: "https://example.com/" }),
      }),
    );
    const frames = received.filter((message) => message.type === "browser.frame");
    expect(frames).toHaveLength(1);
    const first = frames[0];
    if (first?.type !== "browser.frame") throw new Error("Expected frame");
    f.client.send({
      type: "browser.ack",
      requestId: "ack",
      threadId,
      sequence: first.frame.sequence,
    });
    await f.client.request({ type: "browser.unsubscribe", threadId });
    expect(received.filter((message) => message.type === "browser.frame")).toHaveLength(2);
    expect(
      await f.client.request({
        type: "preview.request",
        threadId,
        operation: { op: "forward", port: 3000 },
      }),
    ).toMatchObject({ ok: true, previews: [{ port: 3000 }] });
    expect(
      await f.client.request({
        type: "preview.request",
        threadId,
        operation: { op: "unforward", port: 3000 },
      }),
    ).toMatchObject({ ok: true, previews: [] });
  } finally {
    stop();
    await f.client.close();
  }
});

test("fake draft uploads refuse unfinished adoption and retain committed upload receipts", async () => {
  const f = await fixture();
  try {
    const draft = await f.client.request({
      type: "context.request",
      operation: { op: "draft.create", workspaceId: WorkspaceId.parse("workspace") },
    });
    if (draft.result.kind !== "draft") throw new Error("Expected draft");
    const bytes = new TextEncoder().encode("attachment bytes");
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const upload = await f.client.request({
      type: "context.request",
      operation: {
        op: "draft.upload.begin",
        draftId: draft.result.draftId,
        sha256,
        bytes: bytes.length,
        name: "note.txt",
      },
    });
    if (upload.result.kind !== "upload") throw new Error("Expected upload");
    const create = {
      type: "thread.create" as const,
      provider: "codex" as const,
      workspaceId: WorkspaceId.parse("workspace"),
      context: { draftId: draft.result.draftId, mentions: [], attachments: [] },
      input: [{ type: "text" as const, text: "Synthetic" }],
    };
    expect(await f.client.command(create, {}, "unfinished")).toMatchObject({
      ok: false,
      error: "busy",
    });
    expect(f.daemon.snapshot({ kind: "threads" })).toMatchObject({ threads: {} });
    await f.client.request({
      type: "context.request",
      operation: {
        op: "upload.chunk",
        uploadId: upload.result.uploadId,
        offset: 0,
        data: btoa("attachment bytes"),
      },
    });
    const commit = () =>
      f.client.request({
        type: "context.request",
        operation: {
          op: "upload.commit",
          uploadId: upload.result.kind === "upload" ? upload.result.uploadId : "missing",
        },
      });
    const first = await commit();
    expect((await commit()).result).toEqual(first.result);
    const created = await f.client.command(create, {}, "complete");
    if (!created.threadId) throw new Error("Expected thread");
    expect(
      await f.client.request({
        type: "context.request",
        operation: {
          op: "attachment.list",
          threadId: created.threadId,
        },
      }),
    ).toMatchObject({
      result: { kind: "attachments", attachments: [{ sha256, bytes: bytes.length }] },
    });
    expect((await commit()).result).toEqual(first.result);
  } finally {
    await f.client.close();
  }
});

test("fake automations publish no next run or admission while globally disabled", async () => {
  const f = await fixture();
  try {
    await f.client.request({
      type: "settings.set",
      key: "automations.enabled",
      value: false,
      layer: { kind: "global" },
    });
    await f.client.request({
      type: "automation.put",
      automation: {
        id: "scheduled",
        title: "Scheduled",
        enabled: true,
        workspace: "workspace",
        provider: "codex",
        prompt: "Synthetic",
        worktree: false,
        missedRun: "skip",
        concurrency: 1,
        jitterMs: 0,
        trigger: {
          kind: "schedule",
          schedule: {
            kind: "cron",
            expression: "0 * * * *",
            timezone: "UTC",
            startAt: 0,
          },
        },
      },
    });
    expect((await f.client.request({ type: "automation.list" })).schedules).toEqual([
      { id: "scheduled", nextRunAt: null },
    ]);
    expect(
      (await f.client.request({ type: "automation.run", id: "scheduled", variables: {} })).ok,
    ).toBe(false);
    await f.client.request({
      type: "settings.set",
      key: "automations.enabled",
      value: true,
      layer: { kind: "global" },
    });
    expect(
      (await f.client.request({ type: "automation.list" })).schedules?.[0]?.nextRunAt,
    ).toBeGreaterThan(1000);
    expect(
      (await f.client.request({ type: "automation.run", id: "scheduled", variables: {} })).run,
    ).toMatchObject({ automationId: "scheduled", status: "running" });
  } finally {
    await f.client.close();
  }
});

test("fake deletion refuses owned terminals and retries the successful delete after release", async () => {
  const f = await fixture();
  f.daemon.createThread({
    id: "owned-terminal",
    workspaceId: "workspace",
    title: "Shell",
    provider: "codex",
  });
  const threadId = ThreadId.parse("owned-terminal");
  try {
    const opened = await f.client.request({
      type: "terminal.request",
      operation: { op: "open", threadId },
    });
    if (!opened.terminal) throw new Error("Expected terminal");
    expect(
      await f.client.command({ type: "thread.delete", threadId }, {}, "busy-delete"),
    ).toMatchObject({ ok: false, error: "thread_busy" });
    expect(
      (await f.client.request({ type: "terminal.request", operation: { op: "list", threadId } }))
        .terminals,
    ).toHaveLength(1);
    expect(
      await f.client.request({
        type: "terminal.request",
        operation: { op: "close", threadId, terminalId: opened.terminal.id },
      }),
    ).toMatchObject({ ok: true });
    const deleted = await f.client.command({ type: "thread.delete", threadId }, {}, "delete-owned");
    expect(deleted).toMatchObject({ ok: true });
    expect(await f.client.command({ type: "thread.delete", threadId }, {}, "delete-owned")).toEqual(
      deleted,
    );
    expect(f.daemon.snapshot({ kind: "thread", threadId })).toBeUndefined();
  } finally {
    await f.client.close();
  }
});

test("fake inline commands expose virtual source and edits become visible only after acceptance", async () => {
  const f = await fixture();
  const request = (input: import("@ace/protocol").PluginClientMessage["request"]) =>
    f.client.request({ type: "pluginRequest", request: input });
  try {
    const prepared = await request({
      type: "plugins.prepare",
      name: "inline-example",
      repository: "fixture",
      ref: "main",
    });
    if (prepared.response.type !== "plugins.review") throw new Error("Expected review");
    await request({
      type: "plugins.accept",
      id: prepared.response.review.id,
      commit: prepared.response.review.commit,
      hash: prepared.response.review.hash,
    });
    const path = ".ace-inline/commands/example.md";
    expect(
      (await request({ type: "plugins.catalog", offset: 0, limit: 50 })).response,
    ).toMatchObject({ components: [{ kind: "command", path }] });
    const read = () =>
      request({ type: "plugins.source", name: "inline-example", path, offset: 0, limit: 65536 });
    const before = await read();
    if (before.response.type !== "plugins.source") throw new Error("Expected source");
    expect(before.response).toMatchObject({
      virtual: true,
      manifestPath: ".claude-plugin/plugin.json",
      path: "/fake/plugins/inline-example/.claude-plugin/plugin.json",
    });
    const edited = await request({
      type: "plugins.edit",
      name: "inline-example",
      path,
      expectedHash: before.response.hash,
      text: "Revised command",
    });
    expect((await read()).response).toMatchObject({ text: before.response.text });
    if (edited.response.type !== "plugins.review") throw new Error("Expected edit review");
    await request({
      type: "plugins.accept",
      id: edited.response.review.id,
      commit: edited.response.review.commit,
      hash: edited.response.review.hash,
    });
    expect((await read()).response).toMatchObject({ text: "Revised command", virtual: true });
  } finally {
    await f.client.close();
  }
});

test("paired device fixtures stay valid near epoch zero and preserve ages with an epoch clock", () => {
  const young = settingsFixture(1000);
  expect(young.devices.map((device) => [device.createdAt, device.lastSeenAt])).toEqual([
    [0, 0],
    [0, 0],
  ]);
  const now = Date.parse("2026-10-03T12:00:00Z");
  const aged = settingsFixture(now);
  expect(aged.devices[0]).toMatchObject({
    createdAt: now - 12 * 86400000,
    lastSeenAt: now - 120000,
  });
  expect(aged.devices[1]).toMatchObject({
    createdAt: now - 40 * 86400000,
    lastSeenAt: now - 6 * 86400000,
  });
});

test("fake workspace changes preserve preparation selection and reject dirty changes until explicitly allowed", async () => {
  const f = await fixture();
  try {
    const threadId = ThreadId.parse("prepared-workspace");
    const workspaceId = WorkspaceId.parse("project");
    expect(
      await f.client.command({
        type: "thread.prepare",
        threadId,
        workspaceId,
        title: "Prepared",
        provider: "codex",
        mode: "worktree",
        baseBranch: "main",
      }),
    ).toMatchObject({ ok: true, threadId });
    const lease = f.client.thread(threadId);
    const details = await f.client.request({
      type: "workspace.request",
      operation: { op: "thread.details", threadId },
    });
    expect(details.result).toMatchObject({
      kind: "details",
      details: { mode: "worktree", baseBranch: "main" },
    });
    expect(
      await f.client.command({
        type: "thread.workspace.set",
        allowUncommitted: false,
        threadId,
        mode: "local",
        branch: "develop",
      }),
    ).toMatchObject({ ok: true });
    expect(lease.store.thread?.details).toMatchObject({
      mode: "local",
      branch: "develop",
      workspaceChange: { state: "applied" },
    });
    f.daemon.createThread({
      id: "dirty-workspace",
      workspaceId,
      title: "Dirty",
      provider: "codex",
      details: { diff: { files: 1, additions: 1, deletions: 0 } },
    });
    const dirty = ThreadId.parse("dirty-workspace");
    expect(
      await f.client.command({
        type: "thread.workspace.set",
        allowUncommitted: false,
        threadId: dirty,
        mode: "local",
        branch: "develop",
      }),
    ).toMatchObject({ ok: false, error: "git_dirty_worktree" });
    expect(
      await f.client.command({
        type: "thread.workspace.set",
        threadId: dirty,
        mode: "local",
        branch: "develop",
        allowUncommitted: true,
      }),
    ).toMatchObject({ ok: true });
    lease.release();
  } finally {
    await f.client.close();
  }
});
test("a failing service answers with the daemon's error until it is restored", async () => {
  const f = await fixture();
  try {
    f.daemon.failRequests("accounts.list");
    await expect(f.client.request({ type: "accounts.list" })).rejects.toThrow();
    // Other requests are served as usual.
    expect((await f.client.request({ type: "models.list" })).type).toBe("models.result");
    f.daemon.restoreRequests();
    expect((await f.client.request({ type: "accounts.list" })).accounts.length).toBeGreaterThan(0);
  } finally {
    await f.client.close();
  }
});

test("a workspace's scripts can be replaced, down to none", async () => {
  const f = await fixture();
  try {
    f.daemon.createThread({
      id: "t-scripts",
      workspaceId: "notes",
      title: "Notes",
      provider: "claude",
    });
    f.daemon.setScripts("notes", []);
    const reply = await f.client.request({
      type: "workspace.request",
      operation: { op: "scripts.list", threadId: ThreadId.parse("t-scripts") },
    });
    expect(reply.result).toEqual({ kind: "scripts", scripts: [] });
  } finally {
    await f.client.close();
  }
});

test("Deck watches push stable gate times, real fake-thread links and terminal delegation records", async () => {
  const f = await fixture();
  const { ConductorClient } = await import("@ace/client");
  const { ConductorSpec } = await import("@ace/protocol");
  const model = { provider: "codex", model: "scripted", tier: "normal", cost: 0, quota: 1 };
  const spec = ConductorSpec.parse({
    rootAgentId: "root",
    workspaceId: "workspace",
    goal: "A fake Deck",
    repositoryRules: "",
    constraints: {
      providers: ["codex"],
      models: ["scripted"],
      accounts: ["local.codex"],
      budget: 10,
      maxParallel: 1,
      deadline: null,
      stallAfterMs: 1000,
    },
    policies: {
      planApproval: "required",
      merge: "ask",
      maxFixRounds: 1,
      roles: { planner: [model], worker: [model], reviewer: [model], integrator: [model] },
    },
  });
  let next = 0;
  const decks = new ConductorClient(f.client, () => `deck-watch-${++next}`);
  let watch: ReturnType<InstanceType<typeof ConductorClient>["watch"]> | undefined;
  try {
    expect(await f.client.command({ type: "conductor.start", runId: "deck", spec })).toMatchObject({
      ok: true,
    });
    watch = decks.watch("deck");
    await expect.poll(() => watch?.run.getSnapshot()?.needsUser.length).toBe(1);
    const gated = watch.run.getSnapshot();
    const gate = gated?.needsUser[0];
    if (!gate) throw new Error("Gate missing");
    expect(gated?.startedAt).toBe(1000);
    expect(gate.gatedAt).toBe(1000);
    expect(
      await f.client.command({
        type: "conductor.approve",
        runId: "deck",
        approval: { gateId: gate.id, decision: "approve" },
      }),
    ).toMatchObject({ ok: true });
    await expect.poll(() => watch?.run.getSnapshot()?.delegations.length).toBe(2);
    const worker = watch.run.getSnapshot()?.delegations[0];
    if (!worker) throw new Error("Delegation missing");
    expect(
      f.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(worker.threadId) }),
    ).toMatchObject({ thread: { rootAgentId: worker.agentId, status: { state: "working" } } });
    expect(
      f.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(worker.parentThreadId) }),
    ).toMatchObject({ thread: { status: { state: "working" } } });
    expect(await f.client.command({ type: "conductor.cancel", runId: "deck" })).toMatchObject({
      ok: true,
    });
    await expect.poll(() => watch?.run.getSnapshot()?.phase).toBe("cancelled");
    expect(watch.run.getSnapshot()?.delegations[0]?.phase).toBe("settled");
    expect(watch.run.getSnapshot()?.lanes).toEqual([]);
    expect(watch.run.getSnapshot()?.startedAt).toBe(gated?.startedAt);
    expect((await decks.get("deck")).needsUser).toEqual([]);
  } finally {
    watch?.close();
    await f.client.close();
  }
});
test("fake file resumption requires the current validator for nonzero offsets", async () => {
  const f = await fixture();
  f.daemon.createThread({
    id: "resume",
    workspaceId: "workspace",
    title: "Resume",
    provider: "codex",
  });
  const threadId = ThreadId.parse("resume");
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    await f.client.uploadFile(
      {
        threadId,
        path: "resume.dat",
        expected: null,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      (async function* () {
        yield bytes;
      })(),
    );
    const stat = await f.client.request({
      type: "files.request",
      threadId,
      operation: { op: "stat", path: "resume.dat" },
    });
    if (stat.type !== "files.result") throw new Error("stat failed");
    const { version } = z.object({ version: z.string() }).parse(stat.value);
    expect(
      await f.client.request({
        type: "files.request",
        threadId,
        operation: { op: "download", path: "resume.dat", offset: 1 },
      }),
    ).toMatchObject({ type: "files.error", code: "CONFLICT" });
    const chunks: Uint8Array[] = [];
    for await (const chunk of f.client.downloadFile({
      threadId,
      op: "download",
      path: "resume.dat",
      offset: 1,
      validator: version,
    }))
      chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([2, 3]));
  } finally {
    await f.client.close();
  }
});

test("fake Preview subscribers join with current pixels and survive reopening without an old frame ACK", async () => {
  const f = await fixture();
  f.daemon.createThread({
    id: "preview-generation",
    workspaceId: "workspace",
    title: "Preview",
    provider: "codex",
  });
  const threadId = ThreadId.parse("preview-generation"),
    workspaceId = WorkspaceId.parse("workspace");
  const seen: Message[] = [];
  f.client.onMessage((message) => {
    if (message.type === "browser.frame" || message.type === "browser.state") seen.push(message);
  });
  try {
    await f.client.request({ type: "browser.open", options: { threadId, workspaceId } });
    await f.client.request({ type: "browser.subscribe", threadId, subscriberId: "one" });
    await f.client.request({ type: "diagnostics.health" });
    let before = seen.length;
    await f.client.request({ type: "browser.subscribe", threadId, subscriberId: "two" });
    await f.client.request({ type: "diagnostics.health" });
    expect(seen.slice(before)).toContainEqual(expect.objectContaining({ type: "browser.frame" }));
    await f.client.request({ type: "browser.close", threadId });
    before = seen.length;
    await f.client.request({ type: "browser.open", options: { threadId, workspaceId } });
    await f.client.request({ type: "diagnostics.health" });
    expect(seen.slice(before)).toContainEqual(expect.objectContaining({ type: "browser.frame" }));
    expect(seen.slice(before)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ closed: false }),
      }),
    );
  } finally {
    await f.client.close();
  }
});

test("fake Preview reopening by one client restores the other client's existing subscription", async () => {
  const a = await fixture();
  const b = await fixture(a.daemon);
  a.daemon.createThread({
    id: "two-previews",
    workspaceId: "workspace",
    title: "Preview",
    provider: "codex",
  });
  const threadId = ThreadId.parse("two-previews"),
    workspaceId = WorkspaceId.parse("workspace");
  const first: Message[] = [],
    second: Message[] = [];
  a.client.onMessage((message) => {
    first.push(message);
  });
  b.client.onMessage((message) => {
    second.push(message);
  });
  try {
    await a.client.request({ type: "browser.open", options: { threadId, workspaceId } });
    await a.client.request({ type: "browser.subscribe", threadId });
    await b.client.request({ type: "browser.subscribe", threadId });
    await b.client.request({ type: "browser.close", threadId });
    await a.client.request({ type: "diagnostics.health" });
    const beforeA = first.length,
      beforeB = second.length;
    await b.client.request({ type: "browser.open", options: { threadId, workspaceId } });
    await a.client.request({ type: "diagnostics.health" });
    for (const messages of [first.slice(beforeA), second.slice(beforeB)]) {
      expect(messages).toContainEqual(expect.objectContaining({ type: "browser.frame" }));
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "browser.state",
          state: expect.objectContaining({ closed: false }),
        }),
      );
    }
    const takeover = first.length;
    await b.client.request({ type: "browser.takeover", threadId });
    await a.client.request({ type: "diagnostics.health" });
    expect(first.slice(takeover)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ controller: "human" }),
      }),
    );
  } finally {
    await b.client.close();
    await a.client.close();
  }
});

// Provider status rows also report the synced provider enable setting.
const withEnabled = (rows: readonly object[]) =>
  rows.map((row) => Object.assign({}, row, { enabled: true }));
test("provider discovery keeps native CLI login separate from ace account records", async () => {
  const f = await fixture();
  try {
    f.daemon.services.accounts = [];
    f.daemon.services.providerStatuses = [
      {
        provider: "codex",
        runtime: "cli",
        installed: true,
        path: "/fake/bin/codex",
        version: "0.159.1",
        auth: "logged_out",
        loginHint: "codex login",
        checkedAt: 1000,
        stale: false,
        refreshing: false,
      },
      {
        provider: "claude",
        runtime: "cli",
        installed: true,
        auth: "logged_in",
        accountLabel: "person@example.com",
        loginHint: "claude auth login",
        checkedAt: 1000,
        stale: false,
        refreshing: false,
      },
    ];
    expect(
      (await f.client.request({ type: "providers.request", operation: "list" })).result,
    ).toEqual({ ok: true, providers: withEnabled(f.daemon.services.providerStatuses) });
    f.daemon.services.providerStatuses[0] = {
      ...f.daemon.services.providerStatuses[0],
      provider: "codex",
      runtime: "cli",
      installed: true,
      auth: "logged_in",
      loginHint: "codex login",
      stale: false,
      refreshing: false,
    };
    expect(
      (await f.client.request({ type: "providers.request", operation: "refresh" })).result,
    ).toEqual({ ok: true, providers: withEnabled(f.daemon.services.providerStatuses) });
    f.daemon.projects.seedFolders("/canonical/home", [], { homeLink: "/display/home" });
    expect(
      (await f.client.request({ type: "projects.request", operation: { op: "fs.home" } })).result,
    ).toMatchObject({
      kind: "home",
      path: "/display/home",
      canonicalPath: "/canonical/home",
      roots: ["/canonical/home"],
    });
  } finally {
    await f.client.close();
  }
});

test("fake picker uses the machine's roots, completion and clone contract", async () => {
  const f = await fixture();
  try {
    f.daemon.projects.seedFolders("/home/person", [
      { path: "/home/person/Code", git: true },
      { path: "/home/person/Configs" },
      { path: "/home/person/node_modules/Code" },
      { path: "/home/person/Library/Code" },
      { path: "/home/person/.hidden/Code" },
    ]);
    expect(await f.client.projects.add({ path: "/home/person/Code" })).toMatchObject({ ok: true });
    expect(await f.client.projects.search({ query: "Code" })).toMatchObject({
      result: {
        kind: "search",
        entries: [
          { name: "Code", isGitRepo: true, isProject: true, lastOpened: 1000, recentScore: 1 },
        ],
      },
    });
    expect(await f.client.projects.complete({ path: "~/Co", limit: 1 })).toMatchObject({
      result: {
        kind: "completion",
        commonPrefix: "~/Co",
        candidates: [{ path: "/home/person/Code", completion: "~/Code/" }],
        truncated: true,
      },
    });
    expect(await f.client.projects.validateCloneUrl("arpan404/ace")).toMatchObject({
      result: { kind: "cloneUrl", name: "ace", url: "https://github.com/arpan404/ace.git" },
    });
    expect(
      await f.client.projects.clone({
        parent: "/home/person",
        name: "copied",
        url: "arpan404/ace",
      }),
    ).toMatchObject({
      ok: true,
      inspection: { git: { remotes: [{ fetchUrls: ["https://github.com/arpan404/ace.git"] }] } },
    });
    f.daemon.projects.seedFolders("/home/person", [], { roots: ["/restricted"] });
    expect(await f.client.projects.search({ query: "Code" })).toMatchObject({
      result: { entries: [] },
    });
    expect(await f.client.projects.complete({ path: "~/Co" })).toMatchObject({
      result: { kind: "error", code: "outside_project_roots" },
    });
  } finally {
    await f.client.close();
  }
});

test("removed fake projects lose project and last-opened hints while their folders remain searchable", async () => {
  const f = await fixture();
  try {
    f.daemon.projects.seedFolders("/home/person", [{ path: "/home/person/opened-folder" }]);
    const receipt = await f.client.projects.add({ path: "/home/person/opened-folder" });
    const project = Project.parse(receipt.workspace);
    expect(await f.client.projects.search({ query: "opened-folder" })).toMatchObject({
      result: { entries: [{ isProject: true, lastOpened: 1000 }] },
    });
    expect(await f.client.projects.remove({ workspaceId: project.id })).toMatchObject({ ok: true });
    const result = await f.client.projects.search({ query: "opened-folder" });
    expect(result).toMatchObject({
      result: { entries: [{ name: "opened-folder", isProject: false, recentScore: 0 }] },
    });
    if (result.result.kind !== "search") throw new Error("Expected search");
    expect(result.result.entries[0]).not.toHaveProperty("lastOpened");
  } finally {
    await f.client.close();
  }
});

test("fake completion refuses final traversal and NUL segments and preserves literal backslashes", async () => {
  const f = await fixture();
  try {
    f.daemon.projects.seedFolders("/host/home", [{ path: "/host/home/literal\\Library" }]);
    for (const path of ["~/..", "~/bad\0name", "/host/home/..", "/host/home/bad\0name"])
      expect(await f.client.projects.complete({ path })).toMatchObject({
        result: { kind: "error", code: "invalid_path" },
      });
    expect(await f.client.projects.search({ query: "literal" })).toMatchObject({
      result: { entries: [{ name: "literal\\Library" }] },
    });
    expect(await f.client.projects.complete({ path: "~/literal" })).toMatchObject({
      result: { candidates: [{ name: "literal\\Library", completion: "~/literal\\Library/" }] },
    });
  } finally {
    await f.client.close();
  }
});

test("fake draft images appear as attachment metadata and serve fixture bytes on their owning connection", async () => {
  const f = await fixture();
  try {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const draft = await f.client.request({
      type: "context.request",
      operation: { op: "draft.create", workspaceId: WorkspaceId.parse("workspace") },
    });
    if (draft.result.kind !== "draft") throw new Error("Expected draft");
    const begin = await f.client.request({
      type: "context.request",
      operation: {
        op: "draft.upload.begin",
        draftId: draft.result.draftId,
        sha256,
        bytes: bytes.length,
        name: "screen.txt",
      },
    });
    if (begin.result.kind !== "upload") throw new Error("Expected upload");
    await f.client.request({
      type: "context.request",
      operation: {
        op: "upload.chunk",
        uploadId: begin.result.uploadId,
        offset: 0,
        data: btoa(String.fromCharCode(...bytes)),
      },
    });
    await f.client.request({
      type: "context.request",
      operation: { op: "upload.commit", uploadId: begin.result.uploadId },
    });
    const created = await f.client.command({
      type: "thread.create",
      workspaceId: WorkspaceId.parse("workspace"),
      provider: "codex",
      input: [{ type: "text", text: "inspect" }],
      context: { draftId: draft.result.draftId, mentions: [], attachments: [{ sha256 }] },
    });
    if (!created.threadId) throw new Error("Expected thread");
    const page = await f.client.itemsPage({ threadId: created.threadId, limit: 20 });
    expect(
      page.items.find((item) => item.type === "message" && item.role === "user"),
    ).toMatchObject({
      attachments: [
        {
          sha256,
          name: "screen.txt",
          mimeType: "image/png",
          bytes: bytes.length,
          width: 1,
          height: 1,
          thumbnailAvailable: true,
        },
      ],
    });
    expect(
      (
        await f.client.attachmentBytes({
          threadId: created.threadId,
          sha256,
          variant: "original",
          maxBytes: bytes.length,
        })
      ).bytes,
    ).toEqual(bytes);
    expect((await f.client.attachmentBytes({ threadId: created.threadId, sha256 })).bytes).toEqual(
      bytes,
    );
    await expect(f.client.attachmentBytes({ threadId: "other-thread", sha256 })).rejects.toThrow();
  } finally {
    await f.client.close();
  }
});

test("a queued follow-up is visible before a held queue read returns", async () => {
  const f = await fixture();
  new ScenarioPlayer(f.daemon, flakyCheckout()).runUntilBlocked();
  const threadId = ThreadId.parse("thread-checkout");
  try {
    f.daemon.holdRequests("queue.get");
    const controller = new AbortController();
    const queue = f.client.request({ type: "queue.get", threadId }, { signal: controller.signal });
    const aborted = expect(queue).rejects.toMatchObject({ code: "aborted" });
    const sent = f.client.enqueue(
      {
        type: "thread.send",
        threadId,
        delivery: "queue",
        input: [{ type: "text", text: "Visible before queue.get" }],
      },
      "queued-pill",
    );
    expect(f.client.pendingSends(threadId).getSnapshot()).toMatchObject([
      {
        commandId: "queued-pill",
        itemId: "input:queued-pill",
        state: "saving",
        payload: { delivery: "queue" },
      },
    ]);
    await sent;
    controller.abort();
    await aborted;
    f.daemon.restoreRequests();
    expect(await f.client.request({ type: "queue.get", threadId })).toMatchObject({
      queue: { messages: [{ id: "queued-pill" }] },
    });
  } finally {
    await f.client.close();
  }
});

test("an Activity read mark reaches every connected device, even one that never read the cursor", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const laptop = await fixture(daemon);
  const phone = await fixture(daemon);
  const heard: Message[] = [];
  phone.client.onMessage((message) => heard.push(message));
  await laptop.client.request({
    type: "activity.markRead",
    read: [{ id: "ci:thread:sha", at: 5000 }],
  });
  expect(heard).toContainEqual(
    expect.objectContaining({
      type: "activity.reads.changed",
      cursor: expect.objectContaining({ read: [{ id: "ci:thread:sha", at: 5000 }] }),
    }),
  );
});
