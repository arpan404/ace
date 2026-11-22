import { mkdtemp, rm, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import { expect, it } from "vitest";
import type { LocalAgentStore } from "@cursor/sdk";
import { recoverCursorCheckpoint, CursorLimitsSchema, openSdkCheckpointStore } from "./index.ts";
import type { Recovered } from "./recovery.ts";

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

const agentId = "agent-original";
/** A JSONL SDK store with one agent and the given runs, each with its stored messages. */
async function storeWith(
  root: string,
  runs: { runId: string; status: "running" | "finished"; texts?: string[]; result?: string }[],
  active?: string,
) {
  const store = new JsonlLocalAgentStore(root);
  await store.agents.create({
    agent: {
      agentId,
      cwd: root,
      status: active ? "running" : "idle",
      ...(active ? { activeRunId: active } : {}),
      createdAt: 1,
      // As the SDK leaves it: stamped when it created its newest run.
      updatedAt: runs.length ? 99 + runs.length : 1,
    },
  });
  for (const [index, run] of runs.entries()) {
    await store.runs.create({
      run: {
        runId: run.runId,
        agentId,
        status: run.status,
        turnNumber: index + 1,
        createdAt: 100 + index,
        updatedAt: 100 + index,
        ...(run.result ? { result: run.result } : {}),
      },
    });
    for (const text of run.texts ?? [])
      await store.runEvents.append({
        runId: run.runId,
        eventType: "run_stream_event",
        payload: {
          schemaVersion: 1,
          type: "sdk_message",
          message: {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
        },
      });
  }
  return store;
}
/** Recovery over `store`, as a reopened host runs it, with what the daemon's record lacks. */
async function recover(
  root: string,
  store: LocalAgentStore,
  recoverOptions: {
    runs: { runId: string; through: number; afterOffset?: string }[];
    attempt?: {
      operationId: string;
      segment: number;
      at: number;
      runFramed?: true;
      runId?: string;
    };
  },
) {
  const found: Recovered[] = [];
  const cancelled: string[] = [];
  await recoverCursorCheckpoint(
    {
      Agent: {
        async cancelRun(runId) {
          cancelled.push(runId);
          const run = await store.runs.get({ agentId, runId });
          if (run) await store.runs.update({ run: { ...run, status: "cancelled" } });
        },
      },
    },
    store,
    {
      cwd: root,
      threadId: "ace-thread",
      generation: "replacement",
      nativeSessionId: agentId,
      recover: recoverOptions,
      policy: "full-access",
      autoReviewAvailable: false,
      limits: CursorLimitsSchema.parse({ historyPageSize: 2 }),
    },
    (item) => found.push(item),
  );
  return { found, cancelled };
}
const texts = (found: Recovered[]) =>
  found.flatMap((item) =>
    item.kind === "recovered" ? [JSON.stringify(item.body).match(/"text":"([^"]*)"/)?.[1]] : [],
  );

it("a run that finished just before the daemon crashed comes back finished, with its result and the tail ace missed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-finished-recovery-")));
  try {
    const store = await storeWith(root, [
      { runId: "run", status: "finished", texts: ["seen ", "missed"], result: "the answer" },
    ]);
    const { found, cancelled } = await recover(root, store, {
      runs: [{ runId: "run", through: 1 }],
    });
    expect(cancelled).toEqual([]);
    expect(texts(found)).toEqual(["missed"]);
    expect(found.at(-1)).toMatchObject({
      kind: "recovery",
      runId: "run",
      body: { nativeStatus: "finished", interrupted: false, result: "the answer" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a cut-off run is stopped before its missing tail is read back", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-interrupted-recovery-")));
  try {
    const store = await storeWith(
      root,
      [{ runId: "crashed", status: "running", texts: ["a", "b", "c"] }],
      "crashed",
    );
    const { found, cancelled } = await recover(root, store, {
      runs: [{ runId: "crashed", through: 2 }],
    });
    expect(cancelled).toEqual(["crashed"]);
    expect((await store.runs.get({ agentId, runId: "crashed" }))?.status).toBe("cancelled");
    expect(texts(found)).toEqual(["c"]);
    expect(found.at(-1)).toMatchObject({
      kind: "recovery",
      body: {
        nativeStatus: "running",
        interrupted: true,
        outcome: "interrupted_by_daemon_restart",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** `base`, counting the catalog and event reads recovery makes. */
function counted(base: LocalAgentStore) {
  const reads = { runLists: 0, eventLists: 0 };
  const store: LocalAgentStore = {
    ...base,
    runs: {
      ...base.runs,
      get: (input) => base.runs.get(input),
      create: (input) => base.runs.create(input),
      update: (input) => base.runs.update(input),
      delete: (input) => base.runs.delete(input),
      list: (input) => {
        reads.runLists++;
        return base.runs.list(input);
      },
    },
    runEvents: {
      ...base.runEvents,
      list: (input) => {
        reads.eventLists++;
        return base.runEvents.list(input);
      },
      append: (input) => base.runEvents.append(input),
      delete: (input) => base.runEvents.delete(input),
    },
  };
  return { store, reads };
}
const longHistory = Array.from({ length: 40 }, (_, index) => ({
  runId: `past-${index}`,
  status: "finished" as const,
  texts: ["old"],
}));

it("opening a long Cursor thread with a send in doubt does not read its run history", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-long-recovery-")));
  try {
    const { store, reads } = counted(await storeWith(root, longHistory));
    // The agent is untouched since the attempt: Cursor made no run for it.
    const { found } = await recover(root, store, {
      runs: [],
      attempt: { operationId: "op", segment: 0, at: 500 },
    });
    expect(found).toEqual([
      { kind: "admission", body: { operationId: "op", segment: 0, admitted: false } },
    ]);
    expect(reads).toEqual({ runLists: 0, eventLists: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a cut-off run's tail is read from where ace's record ends, not from the run's first event", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-tail-offset-")));
  try {
    const said = Array.from({ length: 40 }, (_, index) => `t${index} `);
    const { store, reads } = counted(
      await storeWith(root, [{ runId: "long", status: "finished", texts: said }]),
    );
    const events = await store.runEvents.list({ runId: "long", limit: 100 });
    const covered = events.items[37];
    if (!covered) throw new Error("Missing event");
    reads.eventLists = 0;
    const { found } = await recover(root, store, {
      runs: [{ runId: "long", through: covered.seq, afterOffset: covered.offset }],
    });
    expect(said.slice(38)).toEqual(
      found.flatMap((item) =>
        item.kind === "recovered" ? [JSON.stringify(item.body).match(/"text":"([^"]*)"/)?.[1]] : [],
      ),
    );
    // Two events left, two per page: one page and the empty one after it, never the 40.
    expect(reads.eventLists).toBeLessThanOrEqual(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a send in doubt whose run finished is found without the catalog, however long the history", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-long-finished-")));
  try {
    const runs = [...longHistory, { runId: "done", status: "finished" as const, texts: ["new"] }];
    const { store, reads } = counted(await storeWith(root, runs));
    // The agent was touched after the attempt and points at no run: it ended already.
    const at = 99 + runs.length;
    const attempt = { operationId: "op", segment: 0, at, runFramed: true as const };
    const found = await recover(root, store, { runs: [], attempt: { ...attempt, runId: "done" } });
    expect(found.found[0]).toMatchObject({
      kind: "admission",
      body: { admitted: true, nativeRunId: "done" },
    });
    // No id was framed, so the SDK never created a run for it.
    const none = await recover(root, store, { runs: [], attempt });
    expect(none.found).toEqual([
      { kind: "admission", body: { operationId: "op", segment: 0, admitted: false } },
    ]);
    expect(reads.runLists).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a send whose run is still going after a long history is found without the catalog", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-long-active-")));
  try {
    const runs = [...longHistory, { runId: "live", status: "running" as const, texts: ["new"] }];
    const { store, reads } = counted(await storeWith(root, runs, "live"));
    const { found } = await recover(root, store, {
      runs: [],
      attempt: { operationId: "op", segment: 0, at: 100 + longHistory.length },
    });
    expect(found[0]).toMatchObject({
      kind: "admission",
      body: { admitted: true, nativeRunId: "live" },
    });
    expect(reads.runLists).toBe(0);
    // Only the found run's own events are read.
    expect(reads.eventLists).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a send attempted just before a crash is matched to the run Cursor created for it, or reported unsent", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-attempt-recovery-")));
  try {
    const store = await storeWith(root, [
      { runId: "earlier", status: "finished" },
      { runId: "created", status: "finished", texts: ["done"], result: "done" },
    ]);
    const attempt = { operationId: "op", segment: 0 };
    const sent = await recover(root, store, { runs: [], attempt: { ...attempt, at: 101 } });
    expect(sent.found[0]).toMatchObject({
      kind: "admission",
      body: { ...attempt, admitted: true, nativeRunId: "created" },
    });
    expect(texts(sent.found)).toEqual(["done"]);
    const unsent = await recover(root, store, { runs: [], attempt: { ...attempt, at: 500 } });
    expect(unsent.found).toEqual([{ kind: "admission", body: { ...attempt, admitted: false } }]);
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
