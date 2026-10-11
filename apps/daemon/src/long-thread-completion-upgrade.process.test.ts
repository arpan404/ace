import { expect, test } from "vitest";
import { setImmediate } from "node:timers/promises";
import { apply, createThreadState, type Fact } from "@ace/core";
import { storeFixture, turns, catchUp } from "./long-thread-test-support.ts";

for (const evidence of ["snapshot", "canonical"] as const) {
  test.each([
    "diagnostic",
    "active",
    "disconnected",
    "human",
    "descendant",
    "tool",
    "task",
    "retry",
  ] as const)(
    `upgrading old completion indexes with ${evidence} evidence preserves %s work`,
    async (kind) => {
      const h = storeFixture();
      const state = createThreadState({
        threadId: h.thread.id,
        config: { provider: "codex", silenceMs: 100 },
      });
      let serial = 0;
      const feed = (fact: Fact, now: number) => {
        const events = apply(state, fact, { now, ids: { next: () => `upgrade-${++serial}` } });
        // Pre-upgrade canonical events had no completion relevance field.
        h.store.appendEvents(
          h.thread.id,
          events.map((event) => {
            if (event.type !== "agent.status") return event;
            const { completionRelevant: _relevance, ...legacy } = event;
            return legacy;
          }),
          now,
        );
      };
      feed(
        {
          type: "agent.seen",
          agent: "root",
          origin: "root",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: h.home,
        },
        101,
      );
      feed({ type: "turn.started", agent: "root", trigger: "user" }, 102);
      feed({ type: "turn.ended", agent: "root", outcome: "completed" }, 103);
      feed({ type: "usage", agent: "stray", inputTokens: 1, outputTokens: 0 }, 200);
      // This additional diagnostic must be repaired even when the neighbouring
      // child still owns real work or a human wait.
      feed({ type: "usage", agent: "silent", inputTokens: 1, outputTokens: 0 }, 200);
      if (kind === "active") feed({ type: "turn.started", agent: "stray", trigger: "user" }, 201);
      if (kind === "disconnected") feed({ type: "agent.disconnected", agent: "stray" }, 201);
      if (kind === "human")
        feed(
          {
            type: "interaction.opened",
            agent: "stray",
            interaction: "approval",
            blocking: true,
            request: { kind: "plan_review", markdown: "Review", planPath: "/repo/plan.md" },
          },
          201,
        );
      if (kind === "descendant") {
        feed(
          {
            type: "agent.seen",
            agent: "grandchild",
            parent: "stray",
            origin: "provider_subagent",
            fidelity: "full",
            native: { provider: "codex" },
            cwd: h.home,
          },
          201,
        );
        feed({ type: "turn.started", agent: "grandchild", trigger: "user" }, 202);
      }
      if (kind === "tool")
        feed(
          {
            type: "item.upsert",
            agent: "stray",
            item: "shell",
            draft: {
              type: "tool_call",
              call: {
                kind: "shell",
                title: "Shell",
                status: "running",
                detail: { kind: "shell", command: "sleep 60", cwd: h.home },
              },
            },
          },
          201,
        );
      if (kind === "task")
        feed(
          {
            type: "background.started",
            agent: "stray",
            task: "shell",
            kind: "shell",
            title: "Background shell",
            stoppable: true,
          },
          201,
        );
      if (kind === "retry") feed({ type: "retry", agent: "stray", on: "network" }, 201);
      feed({ type: "tick" }, 350);
      expect(turns(h.store, h.thread).turns[0]?.status.state).not.toBe("done");
      expect(catchUp(h.store, h.thread, { sinceSeq: 0 }).turnsCompleted).toBe(0);
      // A genuine upgrade fixture: the old schema, old counters, an indexed event
      // cursor already at the head, and saved core evidence without the new field.
      const saved = structuredClone(state);
      for (const record of Object.values(saved.agents)) delete record.completionRelevant;
      h.store.atomic((db) => {
        db.exec(`ALTER TABLE long_agents DROP COLUMN completion_relevant;
        ALTER TABLE long_completion_migration DROP COLUMN version;
        UPDATE long_completion_migration SET done=1,thread='';`);
        if (evidence === "snapshot") {
          db.exec(`CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,state JSON NOT NULL,seq INTEGER NOT NULL);
          CREATE TABLE engine_state_records(thread_id TEXT NOT NULL,section TEXT NOT NULL,key TEXT NOT NULL,value JSON NOT NULL,PRIMARY KEY(thread_id,section,key));`);
          db.prepare("INSERT INTO thread_state VALUES(?,?,?)").run(
            h.thread.id,
            JSON.stringify({ ...saved, engineSnapshot: 9 }),
            h.store.headSeq(),
          );
        }
      });
      await h.restart();
      const upgraded = turns(h.store, h.thread).turns[0];
      expect(upgraded?.subagents.some((agent) => agent.status.state === "unresponsive")).toBe(true);
      if (kind === "diagnostic") {
        expect(upgraded).toMatchObject({ status: { state: "done" }, endedAt: 350 });
        expect(catchUp(h.store, h.thread, { sinceSeq: 0 }).turnsCompleted).toBe(1);
        expect(catchUp(h.store, h.thread, { sinceTime: 349 }).turnsCompleted).toBe(1);
      } else {
        expect(upgraded?.status.state).not.toBe("done");
        expect(upgraded?.endedAt).toBeUndefined();
        expect(catchUp(h.store, h.thread, { sinceSeq: 0 }).turnsCompleted).toBe(0);
        expect(h.store.getThread(h.thread.id)?.status.state).not.toBe("done");
      }
      const sequence = h.store.headSeq();
      await h.restart();
      expect(h.store.headSeq()).toBe(sequence);
      expect(catchUp(h.store, h.thread, { sinceSeq: 0 }).turnsCompleted).toBe(
        kind === "diagnostic" ? 1 : 0,
      );
    },
  );
}

test("legacy completion replay stays pending through every batch and ready after repair and reopen", async () => {
  const h = storeFixture();
  const state = createThreadState({
    threadId: h.thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  let serial = 0;
  const feed = (fact: Fact, now: number) => {
    const events = apply(state, fact, { now, ids: { next: () => `pending-upgrade-${++serial}` } });
    h.store.appendEvents(
      h.thread.id,
      events.map((event) => {
        if (event.type !== "agent.status") return event;
        const { completionRelevant: _relevance, ...legacy } = event;
        return legacy;
      }),
      now,
    );
  };
  feed(
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex" },
      cwd: h.home,
    },
    101,
  );
  feed({ type: "turn.started", agent: "root", trigger: "user" }, 102);
  feed({ type: "turn.ended", agent: "root", outcome: "completed" }, 103);
  for (let index = 1; index <= 400; index++)
    feed({ type: "usage", agent: "stray", inputTokens: index, outputTokens: 0 }, 200);
  feed({ type: "tick" }, 350);
  expect(h.store.headSeq()).toBeGreaterThan(384);
  h.store.atomic((db) => {
    db.exec(`ALTER TABLE long_agents DROP COLUMN completion_relevant;
      ALTER TABLE long_completion_migration DROP COLUMN version;
      UPDATE long_completion_migration SET done=1,thread='';`);
  });
  await h.restart();
  const pending = () => {
    expect(turns(h.store, h.thread)).toMatchObject({ ready: false, indexedSeq: 0 });
    expect(turns(h.store, h.thread).turns[0]?.status.state).toBe("unresponsive");
    expect(catchUp(h.store, h.thread, { sinceSeq: 0 })).toMatchObject({
      ready: false,
      turnsCompleted: 0,
    });
    expect(catchUp(h.store, h.thread, { sinceTime: 349 })).toMatchObject({
      ready: false,
      turnsCompleted: 0,
    });
  };
  pending();
  await setImmediate();
  pending();
  for (let batch = 0; batch < 100 && !turns(h.store, h.thread).ready; batch++) await setImmediate();
  expect(turns(h.store, h.thread)).toMatchObject({ ready: true, indexedSeq: h.store.headSeq() });
  expect(turns(h.store, h.thread).turns[0]).toMatchObject({
    status: { state: "done" },
    endedAt: 350,
  });
  expect(catchUp(h.store, h.thread, { sinceSeq: 0 })).toMatchObject({
    ready: true,
    turnsCompleted: 1,
  });
  expect(catchUp(h.store, h.thread, { sinceTime: 349 })).toMatchObject({
    ready: true,
    turnsCompleted: 1,
  });
  const sequence = h.store.headSeq();
  await h.restart();
  expect(h.store.headSeq()).toBe(sequence);
  expect(turns(h.store, h.thread)).toMatchObject({ ready: true, indexedSeq: sequence });
  expect(turns(h.store, h.thread).turns[0]).toMatchObject({
    status: { state: "done" },
    endedAt: 350,
  });
  expect(catchUp(h.store, h.thread, { sinceSeq: 0 })).toMatchObject({
    ready: true,
    turnsCompleted: 1,
  });
});
