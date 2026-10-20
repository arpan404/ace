import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { ThreadId } from "@ace/protocol";
import { OffshiftView, type OffshiftCriterion, type OffshiftRequest } from "@ace/protocol/offshift";
import { OffshiftJournal, OffshiftProjectRoles, resolveRole, type Context } from "./index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ace-offshift-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite");
  let db = new DatabaseSync(path);
  const open = () => {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY)");
    return new OffshiftJournal({
      atomic(work) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = work(db);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    });
  };
  let journal = open();
  cleanups.push(() => db.close());
  const threadId = ThreadId.parse(randomUUID());
  const context: Context = {
    threadId,
    caller: { threadId, provider: "codex", model: "gpt-5" },
    now: 1000,
    revision: "revision-1",
    treeState: "working",
  };
  db.prepare("INSERT INTO threads(id) VALUES (?)").run(context.threadId);
  const call = (request: OffshiftRequest) =>
    OffshiftView.parse(journal.execute(request, context).result);
  const start: OffshiftRequest = {
    action: "start",
    runId: "feature",
    requestId: "start",
    outcome: "User can restore an item",
    endpoint: "Verified local change",
    criteria: [
      {
        id: "restore",
        description: "Restore persists after reload",
        requiredKinds: ["automated", "ui"],
      },
    ],
  };
  const get = () => call({ action: "get", runId: "feature" });
  const advance = (phase: "implement" | "verify" | "review" | "delivery") =>
    call({
      action: "advance",
      runId: "feature",
      requestId: `advance-${get().run.version}`,
      version: get().run.version,
      phase,
      note: "Observed phase complete",
    });
  const evidence = (kind: "automated" | "ui", result: "pass" | "fail" = "pass") =>
    call({
      action: "evidence",
      runId: "feature",
      requestId: `evidence-${get().run.version}`,
      version: get().run.version,
      evidence: {
        criterionId: "restore",
        kind,
        result,
        revision: context.revision,
        action: "Restore item and reload",
        artifact: "artifact://report",
        note: "Item remains visible",
      },
    });
  return {
    context,
    call,
    get,
    start,
    advance,
    evidence,
    journal: () => journal,
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      journal = open();
    },
    /** The project-roles store over the same database, as the daemon owner builds it. */
    projectRoles() {
      db.exec("CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY)");
      db.prepare("INSERT OR IGNORE INTO workspaces(id) VALUES ('shop')").run();
      return new OffshiftProjectRoles({
        atomic(work) {
          return work(db);
        },
      });
    },
    deleteThread() {
      db.prepare("DELETE FROM threads WHERE id=?").run(context.threadId);
    },
  };
}

test("acceptance survives reopening and completion waits for every required evidence kind and the whole tree", () => {
  const f = fixture();
  f.call(f.start);
  f.advance("implement");
  f.advance("verify");
  f.evidence("automated");
  f.advance("review");
  expect(() => f.advance("delivery")).toThrow("counting pass");
  f.reopen();
  expect(f.get().pending).toEqual([{ criterionId: "restore", kind: "ui" }]);
  f.evidence("ui");
  expect(f.advance("delivery").state).toBe("waiting_on_tree");
  f.context.treeState = "done";
  expect(f.get().state).toBe("complete");
  for (const state of ["working", "waiting", "needs_you", "unknown", "failed"] as const) {
    f.context.treeState = state;
    expect(f.get().state).toBe("waiting_on_tree");
  }
});

test("source changes and later failed observations revoke readiness instead of retaining old passes", () => {
  const f = fixture();
  f.call(f.start);
  f.advance("implement");
  f.advance("verify");
  f.evidence("automated");
  f.evidence("ui");
  f.advance("review");
  f.advance("delivery");
  f.context.treeState = "done";
  expect(f.get().state).toBe("complete");
  f.context.revision = "revision-2";
  expect(f.get().state).toBe("needs_evidence");
  expect(f.get().pending).toHaveLength(2);
  f.evidence("automated");
  f.evidence("ui");
  expect(f.get().state).toBe("complete");
  f.evidence("automated", "fail");
  expect(f.get().state).toBe("needs_evidence");
});

test("lost-response retries survive restart and cannot overwrite newer edits or replay stale completion", () => {
  const f = fixture();
  f.call(f.start);
  f.advance("implement");
  f.reopen();
  expect(f.call(f.start).run.phase).toBe("implement");
  expect(() => f.call({ ...f.start, outcome: "Different request" })).toThrow("different operation");
  expect(() =>
    f.call({
      action: "advance",
      runId: "feature",
      requestId: "stale-writer",
      version: 0,
      phase: "verify",
      note: "Race",
    }),
  ).toThrow("Run changed");
  expect(f.get().run.phase).toBe("implement");
});

test("stale verification and unrelated criteria are rejected without consuming the mutation identity", () => {
  const f = fixture();
  f.call(f.start);
  const request = {
    action: "evidence",
    runId: "feature",
    requestId: "check",
    version: 0,
    evidence: {
      criterionId: "restore",
      kind: "automated",
      result: "pass",
      revision: "old-revision",
      action: "Run check",
      artifact: "report",
      note: "passed",
    },
  } satisfies OffshiftRequest;
  expect(() => f.call(request)).toThrow("Source changed");
  expect(() =>
    f.call({
      ...request,
      evidence: { ...request.evidence, revision: f.context.revision, criterionId: "other" },
    }),
  ).toThrow("does not match");
  expect(
    f.call({ ...request, evidence: { ...request.evidence, revision: f.context.revision } }).pending,
  ).toEqual([{ criterionId: "restore", kind: "ui" }]);
});

test("blockers survive restart and keep delivery closed until explicitly resolved", () => {
  const f = fixture();
  f.call(f.start);
  f.call({
    action: "block",
    runId: "feature",
    requestId: "block",
    version: 0,
    note: "Need test account",
  });
  f.reopen();
  expect(f.get().state).toBe("blocked");
  expect(() => f.advance("implement")).toThrow("Resolve the recorded blocker");
  f.call({
    action: "resume",
    runId: "feature",
    requestId: "resume",
    version: 1,
    note: "User supplied test account",
  });
  expect(f.advance("implement").state).toBe("active");
});

test("revising a criterion invalidates its earlier passes, keeps others, and survives reopening", () => {
  const f = fixture();
  f.call({
    ...f.start,
    criteria: [
      ...f.start.criteria,
      { id: "audit", description: "Restores are logged", requiredKinds: ["source"] },
    ],
  });
  f.advance("implement");
  f.advance("verify");
  f.evidence("automated");
  f.evidence("ui");
  const revise = (requestId: string, criterion: OffshiftCriterion) => {
    const version = f.get().run.version;
    return f.call({
      action: "revise",
      runId: "feature",
      requestId,
      version,
      criterion,
      note: "Reviewer asked for undo too",
    });
  };
  revise("revise-restore", {
    id: "restore",
    description: "Restore and undo persist after reload",
    requiredKinds: ["automated"],
  });
  f.reopen();
  const revised = f.get();
  expect(revised.run.criteria.map((item) => item.id)).toEqual(["restore", "audit"]);
  expect(revised.pending).toEqual([
    { criterionId: "restore", kind: "automated" },
    { criterionId: "audit", kind: "source" },
  ]);
  expect(() => f.advance("review")).not.toThrow();
  expect(() => f.advance("delivery")).toThrow("counting pass");
  revise("add-export", { id: "export", description: "Export works", requiredKinds: ["ui"] });
  expect(f.get().pending).toContainEqual({ criterionId: "export", kind: "ui" });
});

test("revising is refused while blocked and once a run holds 64 criteria", () => {
  const f = fixture();
  const criteria = Array.from({ length: 64 }, (_, index) => ({
    id: `c${index}`,
    description: "Holds",
    requiredKinds: ["source" as const],
  }));
  f.call({ ...f.start, criteria });
  const criterion = { id: "extra", description: "One more", requiredKinds: ["ui" as const] };
  const revise = (requestId: string, version: number) =>
    f.call({ action: "revise", runId: "feature", requestId, version, criterion, note: "Add" });
  expect(() => revise("too-many", 0)).toThrow("at most 64");
  f.call({ action: "block", runId: "feature", requestId: "block", version: 0, note: "Waiting" });
  expect(() =>
    f.call({
      action: "revise",
      runId: "feature",
      requestId: "while-blocked",
      version: 1,
      criterion: { id: "c0", description: "Changed", requiredKinds: ["source"] },
      note: "Change",
    }),
  ).toThrow("Resolve the recorded blocker");
  expect(f.get().run.criteria).toHaveLength(64);
});

test("calling threads cannot read or mutate each other's runs and deleting a thread removes its records", () => {
  const f = fixture();
  f.call(f.start);
  const otherThread = ThreadId.parse(randomUUID());
  const other = {
    ...f.context,
    threadId: otherThread,
    caller: { ...f.context.caller, threadId: otherThread },
  };
  expect(() => f.journal().execute({ action: "get", runId: "feature" }, other)).toThrow(
    "Run not found",
  );
  expect(f.journal().execute({ action: "list" }, other).result).toEqual([]);
  f.deleteThread();
  expect(() => f.get()).toThrow("Run not found");
});

test("listing full-capacity Unicode outcomes stays within the transport budget and retains full detail on get", () => {
  const f = fixture();
  const outcome = "雪".repeat(4096);
  for (let index = 0; index < 32; index++)
    f.call({ ...f.start, runId: `run-${index}`, requestId: `start-${index}`, outcome });
  const list = f.journal().execute({ action: "list" }, f.context).result;
  expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(65536);
  expect(list).toMatchObject(
    Array.from({ length: 32 }, () => ({ outcome: "雪".repeat(128), outcomeTruncated: true })),
  );
  expect(f.call({ action: "get", runId: "run-0" }).run.outcome).toBe(outcome);
});

test("a request without a requestId applies once, even when retried after a reopen", () => {
  const f = fixture();
  const { requestId: _omit, ...start } = f.start;
  f.call(start);
  const block = {
    action: "block",
    runId: "feature",
    version: 0,
    note: "Need a test account",
  } as const;
  expect(f.call(block).run.version).toBe(1);
  f.reopen();
  // The lost-response retry hashes the same and returns the current view without a second write.
  expect(f.call(block).run).toMatchObject({ version: 1, blocker: "Need a test account" });
  expect(f.call(start).run.version).toBe(1);
  // The same words at the new version are a new change, refused only by the workflow rules.
  expect(() => f.call({ ...block, version: 1 })).not.toThrow();
  expect(f.get().run.version).toBe(2);
});

test("roles start with the run, are replaced whole, and fall back to the project default", () => {
  const f = fixture();
  f.call({ ...f.start, roles: { build: { provider: "codex", model: "gpt-5" } } });
  expect(f.journal().activeRoles(f.context.threadId)).toEqual({
    build: { provider: "codex", model: "gpt-5" },
  });
  f.call({
    action: "roles",
    runId: "feature",
    version: 0,
    roles: { verify: { provider: "claude", effort: "high" } },
  });
  f.reopen();
  const roles = f.journal().activeRoles(f.context.threadId);
  expect(roles).toEqual({ verify: { provider: "claude", effort: "high" } });
  const project = f.projectRoles();
  project.set("shop", { build: { provider: "cursor" }, verify: { provider: "opencode" } });
  const stored = project.get("shop");
  expect(resolveRole("build", roles, stored)).toEqual({
    selection: { provider: "cursor" },
    source: "project",
  });
  expect(resolveRole("verify", roles, stored)?.source).toBe("run");
  expect(resolveRole("review", roles, stored)).toBeUndefined();
  project.set("shop", {});
  expect(project.get("shop")).toBeUndefined();
});

test("a delivered run no longer supplies roles to delegation", () => {
  const f = fixture();
  f.call({
    ...f.start,
    criteria: [{ id: "restore", description: "x", requiredKinds: ["source"] }],
    roles: { build: { provider: "claude" } },
  });
  f.advance("implement");
  f.advance("verify");
  f.call({
    action: "evidence",
    runId: "feature",
    version: f.get().run.version,
    evidence: {
      criterionId: "restore",
      kind: "source",
      result: "pass",
      revision: f.context.revision,
      action: "Read the diff",
      artifact: "diff",
      note: "Matches",
    },
  });
  f.advance("review");
  f.advance("delivery");
  expect(f.journal().activeRoles(f.context.threadId)).toBeUndefined();
});

test("an independent criterion stays pending on the owner's own pass until another provider or model passes it", () => {
  const f = fixture();
  f.call({
    ...f.start,
    criteria: [
      { id: "restore", description: "Restore persists", requiredKinds: ["ui"], independent: true },
    ],
  });
  f.advance("implement");
  f.advance("verify");
  const check = (caller: Context["caller"]) =>
    OffshiftView.parse(
      f.journal().execute(
        {
          action: "evidence",
          runId: "feature",
          version: f.get().run.version,
          evidence: {
            criterionId: "restore",
            kind: "ui",
            result: "pass",
            revision: f.context.revision,
            action: "Restore and reload",
            artifact: "screenshot://restore",
            note: "Item stays",
          },
        },
        { ...f.context, caller },
      ).result,
    );
  const owner = f.context.caller;
  expect(check(owner).pending).toEqual([
    { criterionId: "restore", kind: "ui", needs: "independent" },
  ]);
  // Another thread on the same provider and model is no independent check either.
  const sameModel = { ...owner, threadId: ThreadId.parse(randomUUID()) };
  expect(check(sameModel).pending).toHaveLength(1);
  const child = {
    threadId: ThreadId.parse(randomUUID()),
    provider: "claude" as const,
    model: "opus",
  };
  const passed = check(child);
  expect(passed.pending).toEqual([]);
  expect(passed.run.evidence[0]?.by).toEqual(child);
  // A descendant records evidence only; every other change stays with the owner.
  expect(() =>
    f.journal().execute(
      {
        action: "advance",
        runId: "feature",
        version: passed.run.version,
        phase: "review",
        note: "x",
      },
      { ...f.context, caller: child },
    ),
  ).toThrow("only get the run or record evidence");
  f.reopen();
  expect(f.get().pending).toEqual([]);
});
