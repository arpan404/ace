import { mkdtemp, rm, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import { expect, it } from "vitest";
import {
  CursorJournal,
  recoverCursorCheckpoint,
  boundedCheckpointStore,
  CursorLimitsSchema,
  openSdkCheckpointStore,
  type CursorEnvelope,
} from "./index.ts";

it("retains native SQLite checkpoints and run identity when the thread store closes and reopens", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-sqlite-checkpoint-")));
  let owned: Awaited<ReturnType<typeof openSdkCheckpointStore>> | undefined;
  try {
    owned = await openSdkCheckpointStore({ JsonlLocalAgentStore }, root, root);
    expect(owned.kind).toBe("sqlite");
    await owned.store.agents.create({
      agent: {
        agentId: "agent-original",
        cwd: root,
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await owned.store.runs.create({
      run: {
        agentId: "agent-original",
        runId: "run-original",
        turnNumber: 1,
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const blobId = "ab".repeat(32);
    await owned.store.checkpoints.create({
      agentId: "agent-original",
      blobId,
      data: new Uint8Array([1, 2, 3]),
    });
    await owned.close();
    owned = undefined;
    owned = await openSdkCheckpointStore({ JsonlLocalAgentStore }, root, root);
    expect(
      (await owned.store.runs.get({ agentId: "agent-original", runId: "run-original" }))?.status,
    ).toBe("running");
    expect(await owned.store.checkpoints.get({ agentId: "agent-original", blobId })).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  } finally {
    await owned?.close();
    await rm(root, { recursive: true, force: true });
  }
});

const envelope = (kind: string, body: unknown): CursorEnvelope => ({
  schemaVersion: 1,
  generation: "old-host",
  operationId: "ace-operation",
  segment: 0,
  kind,
  body,
});

it("replays only boundary commits missing from ace and keeps SDK observe offsets separate", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-journal-")));
  try {
    const journal = new CursorJournal(root, 65536, 4096);
    await journal.recover(0, async () => {});
    const a = await journal.append(envelope("delta", { type: "text-delta", text: "same" }));
    const b = await journal.append(envelope("delta", { type: "text-delta", text: "same" }));
    expect(a.boundaryOffset).toBe(1);
    expect(b.boundaryOffset).toBe(2);
    await journal.close();
    const recovered: CursorEnvelope[] = [];
    const next = new CursorJournal(root, 65536, 4096);
    await next.recover(1, async (frame) => {
      recovered.push(frame);
    });
    expect(recovered).toEqual([{ ...b, replayed: true }]);
    expect(recovered[0]?.observeOffset).toBeUndefined();
    expect((await next.append(envelope("result", { status: "finished" }))).boundaryOffset).toBe(3);
    await next.close();
    await expect(new CursorJournal(root, 65536, 4096).recover(4, async () => {})).rejects.toThrow(
      "conflicts",
    );
    await writeFile(join(root, "ace-boundary.ndjson"), '{"torn":', { flag: "a" });
    await expect(new CursorJournal(root, 65536, 4096).recover(3, async () => {})).rejects.toThrow();
    expect(await readFile(join(root, "ace-boundary.ndjson"), "utf8")).toContain('{"torn":');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reconciles crashed native runs before continuation without resending or altering completed outcomes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-native-recovery-")));
  try {
    const store = new JsonlLocalAgentStore(root);
    await store.agents.create({
      agent: {
        agentId: "agent-original",
        cwd: root,
        status: "running",
        activeRunId: "crashed",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    for (const [runId, status] of [
      ["finished", "finished"],
      ["crashed", "running"],
    ] as const)
      await store.runs.create({
        run: {
          runId,
          agentId: "agent-original",
          status,
          turnNumber: runId === "finished" ? 1 : 2,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    await store.runEvents.append({
      runId: "crashed",
      eventType: "synthetic-durable",
      payload: { type: "status" },
    });
    const notices: { kind: string; body: unknown; runId?: string; offset?: string }[] = [];
    const id = await recoverCursorCheckpoint(
      {
        Agent: {
          async cancelRun(runId) {
            const run = await store.runs.get({ agentId: "agent-original", runId });
            if (!run) throw new Error("Missing run");
            await store.runs.update({ run: { ...run, status: "cancelled" } });
          },
        },
      },
      store,
      {
        cwd: root,
        threadId: "ace-thread",
        generation: "replacement",
        nativeSessionId: "agent-original",
        afterFrameOffset: 0,
        policy: "full-access",
        autoReviewAvailable: false,
        limits: CursorLimitsSchema.parse({ historyPageSize: 1 }),
      },
      async (kind, body, runId, offset) => {
        notices.push({ kind, body, ...(runId ? { runId } : {}), ...(offset ? { offset } : {}) });
      },
    );
    expect(id).toBe("agent-original");
    expect((await store.runs.get({ agentId: id ?? "", runId: "crashed" }))?.status).toBe(
      "cancelled",
    );
    expect((await store.runs.get({ agentId: id ?? "", runId: "finished" }))?.status).toBe(
      "finished",
    );
    expect(notices).toContainEqual(
      expect.objectContaining({
        runId: "crashed",
        offset: "1",
        body: expect.objectContaining({ outcome: "interrupted_by_daemon_restart" }),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fences oversized native checkpoint writes while retaining the previous checkpoint", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-checkpoint-write-")));
  try {
    let visible = "";
    const base = new JsonlLocalAgentStore(root);
    const store = boundedCheckpointStore(base, root, 4096, async () => {
      visible = "checkpoint failed";
    });
    await store.checkpoints.create({
      agentId: "agent",
      blobId: "original",
      data: new Uint8Array([1, 2]),
    });
    await expect(
      store.checkpoints.create({
        agentId: "agent",
        blobId: "too-large",
        data: new Uint8Array(8192),
      }),
    ).rejects.toThrow("exceeds budget");
    expect(visible).toBe("checkpoint failed");
    expect(
      new Uint8Array((await base.checkpoints.get({ agentId: "agent", blobId: "original" })) ?? []),
    ).toEqual(new Uint8Array([1, 2]));
    expect(await base.checkpoints.get({ agentId: "agent", blobId: "too-large" })).toBeNull();
    await expect(
      store.checkpoints.update({ agentId: "agent", blobId: "original", data: new Uint8Array([3]) }),
    ).rejects.toThrow("fenced");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses conflicting or incomplete native checkpoint formats without overwriting them", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-store-conflict-")));
  try {
    const legacy = join(root, "run_events.ndjson");
    await writeFile(legacy, "preserved");
    await expect(openSdkCheckpointStore({ JsonlLocalAgentStore }, root, root)).rejects.toThrow(
      "Incomplete",
    );
    expect(await readFile(legacy, "utf8")).toBe("preserved");
    await writeFile(join(root, "agents.ndjson"), "preserved-agent");
    await writeFile(join(root, "index.db"), "preserved-sqlite");
    await expect(openSdkCheckpointStore({ JsonlLocalAgentStore }, root, root)).rejects.toThrow(
      "conflict",
    );
    expect(await readFile(join(root, "index.db"), "utf8")).toBe("preserved-sqlite");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("recovery skips committed native observations without treating later Send callbacks as observe positions", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-observe-cursor-")));
  const journal = new CursorJournal(root, 65536, 4096);
  const recovered = new CursorJournal(root, 65536, 4096);
  try {
    const store = new JsonlLocalAgentStore(root);
    await store.agents.create({
      agent: { agentId: "agent", cwd: root, status: "idle", createdAt: 1, updatedAt: 1 },
    });
    await store.runs.create({
      run: {
        agentId: "agent",
        runId: "run",
        turnNumber: 1,
        status: "finished",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const first = await store.runEvents.append({
      runId: "run",
      eventType: "first",
      payload: { text: "already observed" },
    });
    const second = await store.runEvents.append({
      runId: "run",
      eventType: "second",
      payload: { text: "unobserved" },
    });
    await journal.recover(0, async () => {});
    await journal.append({
      ...envelope("observe", { eventSeq: first.seq }),
      runId: "run",
      observeOffset: first.offset,
    });
    for (const text of ["send callback one", "send callback two"])
      await journal.append({ ...envelope("delta", { type: "text-delta", text }), runId: "run" });
    await journal.close();
    await recovered.recover(3, async () => {});
    const observed: unknown[] = [];
    await recoverCursorCheckpoint(
      {
        Agent: {
          async cancelRun() {
            throw new Error("Completed run must not be cancelled");
          },
        },
      },
      store,
      {
        cwd: root,
        threadId: "ace-thread",
        generation: "new-host",
        nativeSessionId: "agent",
        afterFrameOffset: 3,
        policy: "full-access",
        autoReviewAvailable: false,
        limits: CursorLimitsSchema.parse({ historyPageSize: 1 }),
      },
      async (kind, body, runId, offset) => {
        if (kind === "observe") observed.push({ body, runId, offset });
      },
      (runId) => recovered.afterObserve(runId),
    );
    expect(observed).toEqual([
      {
        body: { eventType: "second", eventSeq: second.seq, payload: { text: "unobserved" } },
        runId: "run",
        offset: second.offset,
      },
    ]);
  } finally {
    await journal.close();
    await recovered.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a torn legacy checkpoint rather than allowing the SDK to discard its final record", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-legacy-torn-")));
  try {
    const path = join(root, "agents.ndjson");
    const original = '{"agentId":"original","cwd":"/workspace"}\n{"agentId":';
    await writeFile(path, original);
    await expect(openSdkCheckpointStore({ JsonlLocalAgentStore }, root, root)).rejects.toThrow(
      "incomplete or malformed",
    );
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
