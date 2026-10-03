import { expect, test } from "vitest";
import { Client } from "@ace/client";
import {
  DeviceId,
  WorkspaceId,
  ThreadId,
  ServerMessage,
  type ServerMessage as Message,
} from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

async function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
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
      components: [{ plugin: "example", kind: "skill", enabled: true }],
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
    await expect(
      f.client.request({
        type: "browser.execute",
        threadId,
        command: { action: "navigate", url: "https://example.com" },
      }),
    ).rejects.toMatchObject({ code: "daemon" });
    await f.client.request({ type: "browser.handback", threadId });
    await f.client.request({
      type: "browser.execute",
      threadId,
      command: { action: "navigate", url: "https://example.com" },
    });
    expect(received).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ url: "https://example.com" }),
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
