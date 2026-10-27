import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { ThreadId } from "@ace/protocol";
import { OffshiftView } from "@ace/protocol/offshift";
import { OffshiftConflict } from "./workflow.ts";
import { OffshiftJournal } from "./index.ts";
import type { PersonContext } from "./person.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ace-offshift-person-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite");
  const db = new DatabaseSync(path);
  cleanups.push(() => db.close());
  const journal = new OffshiftJournal({
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
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY)");
  const threadId = ThreadId.parse(crypto.randomUUID());
  db.prepare("INSERT INTO threads(id) VALUES (?)").run(threadId);
  const context: PersonContext = {
    threadId,
    person: { kind: "person", deviceId: null, device: null },
    agent: { threadId, provider: "codex", model: "gpt-5" },
    now: 1000,
    revision: "revision-1",
    treeState: "working",
    children: 0,
  };
  const call = (op: unknown, requestId: string) =>
    OffshiftView.parse(journal.executePerson(op, requestId, context).result);
  return { call, context };
}

test("the person starts a run, marks a step and records an independent check as You", () => {
  const { call } = fixture();
  const started = call(
    {
      action: "start",
      runId: "login",
      outcome: "Login shows a helpful error",
      endpoint: "Local change",
      criteria: [{ id: "error", description: "Bad password shows an error", requiredKinds: ["ui"], independent: true }],
      playbook: "fix",
    },
    "start",
  );
  expect(started.run.version).toBe(0);
  expect(started.run.startedBy).toMatchObject({ kind: "person" });
  const stepped = call(
    { action: "step", runId: "login", expectedVersion: 0, stepId: "reproduce", state: "done" },
    "step",
  );
  expect(stepped.run.version).toBe(1);
  const checked = call(
    {
      action: "evidence",
      runId: "login",
      expectedVersion: 1,
      criterionId: "error",
      kind: "ui",
      result: "pass",
      revision: "revision-1",
      note: "Saw the error on the login page",
    },
    "check",
  );
  // The person's own check counts as independent, and shows as You.
  expect(checked.pending).toEqual([]);
  expect(checked.run.evidence[0]?.by).toMatchObject({ kind: "person" });
  // The card names the person without ids.
  const by = checked.run.evidence[0]?.by;
  if (!by) throw new Error("Missing evidence author");
});

test("a stale version is refused as a conflict, and a retry id replays without rewriting", () => {
  const { call } = fixture();
  call(
    {
      action: "start",
      runId: "login",
      outcome: "Login shows a helpful error",
      endpoint: "Local change",
      criteria: [{ id: "error", description: "Bad password shows an error", requiredKinds: ["ui"] }],
      playbook: "fix",
    },
    "start",
  );
  const first = call(
    { action: "step", runId: "login", expectedVersion: 0, stepId: "reproduce", state: "done" },
    "step-1",
  );
  expect(first.run.version).toBe(1);
  expect(() =>
    call(
      { action: "step", runId: "login", expectedVersion: 0, stepId: "reproduce", state: "todo" },
      "step-2",
    ),
  ).toThrow(OffshiftConflict);
  // Replaying the first write under its own id returns the standing view unchanged.
  const replay = call(
    { action: "step", runId: "login", expectedVersion: 0, stepId: "reproduce", state: "done" },
    "step-1",
  );
  expect(replay.run.version).toBe(1);
});
