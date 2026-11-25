// SPDX-License-Identifier: Apache-2.0
/**
 * E5.3's native proof (step 12): the engine's own persistence, asserted on its own rows with plain
 * SQL, never through `store.snapshotThread` (which reads the store's projections, not the
 * engine's header, records or appends).
 *
 * Each case names the (a) test that will replace it and is deleted when that file first passes
 * switch-on:
 * - the smoke: `storage-behaviour.process` (E5.6's session seeding);
 * - the folded batch: `records-write-budget.process`, `item-metadata.process` (E5.6);
 * - the rolled-back fold and the quarantine reload: `snapshot-rollback.process`,
 *   `live-write-quarantine.process` (E5.6/E5.8);
 * - the startup scan: `startup-quarantine.process` (E5.8).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createThreadState } from "@ace/core";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { createDevThread } from "../commands.ts";
import { engineSeam, type EngineSeam } from "./testing.ts";

const native = engineBackend() === "native";

/** A header a fresh thread would have: the core's own state, version 9. */
function freshHeader(threadId: string): string {
  const state = createThreadState({
    threadId: threadId as never,
    rootAgent: {
      agent: "root" as never,
      fidelity: "full" as never,
      native: { provider: "claude", nativeId: "native-root" } as never,
      cwd: "/tmp",
    },
    config: { provider: "claude", silenceMs: 30_000 },
  });
  return JSON.stringify({ ...state, engineSnapshot: 9 });
}

/** A thread with a stored engine state, so `apply` has one to fold into. */
function seedStatefulThread(seam: EngineSeam, header = freshHeader): string {
  const workspace = seam.store.createWorkspace(seam.home, "E5.3");
  const thread = createDevThread(seam.store, workspace);
  seam.store.atomic((db) => {
    db.prepare("INSERT INTO thread_state VALUES (?, ?, ?)").run(
      thread.id,
      header(thread.id),
      seam.store.headSeq(),
    );
  });
  return thread.id;
}

type Row = Record<string, unknown>;

/** The engine's own rows, read with plain SQL from the test. */
function engineRows(seam: EngineSeam, threadId: string) {
  return seam.store.atomic((db) => ({
    header: db.prepare("SELECT state,seq FROM thread_state WHERE thread_id=?").get(threadId) as
      | Row
      | undefined,
    records: db
      .prepare(
        "SELECT section,key,value FROM engine_state_records WHERE thread_id=? ORDER BY rowid",
      )
      .all(threadId) as Row[],
    appends: db
      .prepare("SELECT section,key,patch FROM engine_state_appends WHERE thread_id=? ORDER BY id")
      .all(threadId) as Row[],
  }));
}

/** A turn that starts, writes a message and its text, then ends. */
function turnFacts(text: string, agent = "root"): unknown[] {
  return [
    { type: "turn.started", agent, trigger: "user", nativeTurnId: "turn-1" },
    {
      type: "item.upsert",
      agent,
      item: "item-1",
      draft: {
        id: "item-1",
        threadId: "t",
        agentId: agent,
        createdAt: 1,
        complete: true,
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "" }],
      },
    },
    { type: "item.delta", agent, item: "item-1", field: "text", append: text },
    { type: "turn.ended", agent, nativeTurnId: "turn-1", outcome: "completed" },
  ];
}

describe.runIf(native)("engine persistence", () => {
  test("the engine constructs, becomes ready, flushes and closes on a fresh home and on a seeded one, with one evidence line", async () => {
    const evidence = join(mkdtempSync(join(tmpdir(), "ace-engine-evidence-")), "evidence");
    process.env.ACE_ENGINE_EVIDENCE = evidence;
    const fresh = await engineSeam();
    try {
      await fresh.engine.ready();
      await fresh.engine.flush();
    } finally {
      await fresh.close();
    }
    const seeded = await engineSeam({
      afterOpen: (store) => {
        const workspace = store.createWorkspace(seededHome(), "Seeded");
        const thread = createDevThread(store, workspace);
        store.atomic((db) => {
          db.prepare("INSERT INTO thread_state VALUES (?, ?, ?)").run(
            thread.id,
            freshHeader(thread.id),
            store.headSeq(),
          );
          db.prepare("UPDATE threads SET status=? WHERE id=?").run(
            JSON.stringify({ state: "done" }),
            thread.id,
          );
        });
      },
    });
    try {
      await seeded.engine.ready();
      await seeded.engine.flush();
    } finally {
      await seeded.close();
    }
    const lines = readFileSync(evidence, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d+ engine$/);
  });

  test("a folded batch stores the expected engine rows, and a fresh engine reopens and continues them", async () => {
    const seam = await engineSeam();
    let threadId = "";
    try {
      await seam.engine.ready();
      seam.probe.passThroughCollaborators();
      threadId = seedStatefulThread(seam);
      seam.probe.apply(threadId, turnFacts("hello"), 1_000);
      const rows = engineRows(seam, threadId);
      const header = JSON.parse(String(rows.header?.state)) as Row;
      expect(header["engineSnapshot"]).toBe(9);
      expect(header["agents"]).toEqual({});
      expect(header["items"]).toEqual({});
      const sections = rows.records.map((row) => String(row["section"]));
      expect(sections).toContain("agents");
      expect(sections).toContain("items");
      expect(sections).toContain("runs");
      const item = rows.records.find(
        (row) => row["section"] === "items" && row["key"] === "item-1",
      );
      expect(item).toBeDefined();
      // The upsert carried the text, so this batch stored no patch for it.
      const stored = JSON.parse(String(item?.value)) as Row;
      expect(JSON.stringify(stored["parts"])).toBe('[{"type":"text","text":"hello"}]');
      expect(rows.appends.filter((row) => row["key"] === "item-1")).toHaveLength(0);
      expect(Number(rows.header?.seq)).toBe(seam.store.headSeq());
      // A fresh engine on the same home folds one more delta and one more turn.
      const reopened = await seam.reopen();
      try {
        await reopened.engine.ready();
        reopened.probe.passThroughCollaborators();
        reopened.probe.apply(
          threadId,
          [
            { type: "item.delta", agent: "root", item: "item-1", field: "text", append: " again" },
            { type: "turn.ended", agent: "root", nativeTurnId: "turn-1", outcome: "completed" },
          ],
          2_000,
        );
        const after = engineRows(reopened, threadId);
        const appends = after.appends.filter((row) => row["key"] === "item-1");
        expect(appends).toHaveLength(1);
        expect(JSON.parse(String(appends[0]?.["patch"]))).toEqual({
          path: ["parts", 0, "text"],
          text: " again",
          seed: { type: "text" },
        });
        // The stored record still holds the pre-append text; the patch carries the rest.
        const kept = after.records.find(
          (row) => row["section"] === "items" && row["key"] === "item-1",
        );
        const parts = (JSON.parse(String(kept?.value)) as Row)["parts"];
        expect(JSON.stringify(parts)).toBe('[{"type":"text","text":"hello"}]');
        // The turn ended the stored run.
        const runs = after.records.filter((row) => row["section"] === "runs");
        expect(runs.length).toBeGreaterThan(0);
        expect(runs.map((row) => JSON.parse(String(row["value"])) as Row)).toEqual(
          expect.arrayContaining([expect.objectContaining({ state: "completed" })]),
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await seam.close();
    }
  });

  test("an established delta takes the buffered live path and the store's flush settles it", async () => {
    const seam = await engineSeam();
    let threadId = "";
    try {
      await seam.engine.ready();
      seam.probe.passThroughCollaborators();
      threadId = seedStatefulThread(seam);
      seam.probe.apply(threadId, turnFacts("hello"), 1_000);
      // A delta on a committed thread goes through the store's one live buffer (E5.2 step 16).
      const buffered = seam.probe.stream(
        threadId,
        [{ type: "item.delta", agent: "root", item: "item-1", field: "text", append: " more" }],
        2_000,
      );
      expect(buffered).toBe(true);
      // The buffer's own flush (its timer's call) runs the engine's `persist` and `committed`
      // entries for this token inside the flush's transaction.
      seam.store.flushLiveWrites();
      expect(seam.store.hasLiveWrite(threadId as never)).toBe(false);
      const rows = engineRows(seam, threadId);
      const appends = rows.appends.filter((row) => row["key"] === "item-1");
      expect(appends).toHaveLength(1);
      expect(JSON.parse(String(appends[0]?.["patch"]))).toEqual({
        path: ["parts", 0, "text"],
        text: " more",
        seed: { type: "text" },
      });
      expect(seam.probe.holds(threadId)).toBe(true);
    } finally {
      await seam.close();
    }
  });

  test("a rolled-back fold leaves no record in the budget, its rows are unchanged, and the next fold reloads from SQLite", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      seam.probe.passThroughCollaborators();
      const threadId = seedStatefulThread(seam);
      seam.probe.apply(threadId, turnFacts("stored"), 1_000);
      const before = engineRows(seam, threadId);
      expect(before.records.length).toBeGreaterThan(0);
      expect(() => seam.probe.applyRolledBack(threadId, turnFacts("rolled back"), 2_000)).toThrow();
      const after = engineRows(seam, threadId);
      expect(after.records).toEqual(before.records);
      expect(after.appends).toEqual(before.appends);
      expect(after.header?.state).toEqual(before.header?.state);
      // The rollback bumps the generation; the next read syncs and drops the snapshot, so its
      // cached records leave the budget.
      expect(seam.probe.rollbackGeneration()).toBeGreaterThan(0);
      const budgetBefore = seam.probe.budget().entries;
      // `hasState` syncs against the new generation, drops and releases the stale snapshot, and
      // reloads from SQLite. The reload's records are the stored state and the index sections a
      // header empties, never the rolled-back fold's; Rust reads those sections at load where
      // the TypeScript's proxies read them lazily, so the budget is not the zero the internal
      // case saw (recorded in `docs/engine/behaviour.md`).
      expect(seam.engine.hasState(threadId as never)).toBe(true);
      expect(seam.probe.budget().entries).toBeLessThanOrEqual(budgetBefore);
      // The next fold reloads the stored state and continues it.
      seam.probe.apply(threadId, turnFacts("again"), 3_000);
      const resumed = engineRows(seam, threadId);
      expect(resumed.appends.length).toBeGreaterThan(after.appends.length);
    } finally {
      await seam.close();
    }
  });

  test("a quarantined thread with no actor reloads its stored state", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      seam.probe.passThroughCollaborators();
      const threadId = seedStatefulThread(seam);
      seam.probe.apply(threadId, turnFacts("persisted"), 1_000);
      const rows = engineRows(seam, threadId);
      expect(seam.probe.holds(threadId)).toBe(true);
      seam.probe.quarantine(threadId);
      expect(seam.probe.holds(threadId)).toBe(false);
      // No actor exists for this thread: the stored row is still there, and the next fold
      // reloads the state from SQLite on its own.
      expect(seam.engine.hasState(threadId as never)).toBe(true);
      expect(engineRows(seam, threadId).records).toEqual(rows.records);
      seam.probe.apply(threadId, turnFacts("after"), 2_000);
      expect(seam.probe.holds(threadId)).toBe(true);
      expect(engineRows(seam, threadId).appends.length).toBeGreaterThan(rows.appends.length);
    } finally {
      await seam.close();
    }
  });

  test("startup recovery over 600 candidate threads with 300 non-candidates between them takes several scan steps, the event loop runs between them, and ready() resolves after the last", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-engine-scan-"));
    const reports: string[] = [];
    const seam = await engineSeam({
      options: {
        home,
        onError: (error: unknown) => {
          reports.push(String(error));
        },
      },
      afterOpen: (store) => {
        const workspace = store.createWorkspace(home, "Scan");
        store.atomic((db) => {
          const thread = db.prepare(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) VALUES (?, ?, ?, 'claude', ?, 0, 0)",
          );
          const state = db.prepare("INSERT INTO thread_state VALUES (?, ?, 0)");
          for (let index = 0; index < 900; index += 1) {
            const id = `thread-${String(index).padStart(4, "0")}`;
            // Every third thread is a candidate whose header this build cannot read: reported
            // and skipped, exactly like an unreadable thread at startup.
            // Two candidates for every non-candidate: 600 candidates among 900 threads.
            const candidate = index % 3 !== 0;
            thread.run(
              id,
              workspace,
              `thread ${index}`,
              JSON.stringify({ state: candidate ? "working" : "done" }),
            );
            // A damaged version-9 header: reported and skipped, so the rest recover.
            if (candidate)
              state.run(id, JSON.stringify({ engineSnapshot: 9, threadId: id, config: {} }));
          }
        });
      },
    });
    try {
      let turns = 0;
      let running = true;
      const counter = () => {
        if (!running) return;
        turns += 1;
        setImmediate(counter);
      };
      setImmediate(counter);
      await seam.engine.ready();
      running = false;
      expect(turns).toBeGreaterThan(1);
      expect(reports.length).toBe(600);
      const pages = seam.probe.candidatePages();
      expect(pages.length).toBeGreaterThan(0);
    } finally {
      await seam.close();
    }
  }, 30_000);

  test("another build's snapshot version refuses readiness instead of hiding the history", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-engine-refuse-"));
    const seam = await engineSeam({
      options: { home },
      afterOpen: (store) => {
        const workspace = store.createWorkspace(home, "Refuse");
        store.atomic((db) => {
          const thread = db.prepare(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) VALUES (?, ?, ?, 'claude', ?, 0, 0)",
          );
          const state = db.prepare("INSERT INTO thread_state VALUES (?, ?, 0)");
          thread.run("newer", workspace, "newer", JSON.stringify({ state: "working" }));
          state.run("newer", JSON.stringify({ engineSnapshot: 8 }));
        });
      },
    });
    try {
      // `skippableAtStartup` refuses the home for data another build wrote (`startup-skip.ts:9`).
      await expect(seam.engine.ready()).rejects.toThrow(/Unsupported engine snapshot format/);
    } finally {
      await seam.close();
    }
  });

  test("an unported collaborator fails at the call", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      const threadId = seedStatefulThread(seam);
      expect(() => seam.probe.apply(threadId, turnFacts("x"), 1_000)).toThrow(
        /NativeEngineIncomplete: .* lands in E5\./,
      );
    } finally {
      await seam.close();
    }
  });
});

function seededHome(): string {
  return mkdtempSync(join(tmpdir(), "ace-engine-seeded-"));
}
