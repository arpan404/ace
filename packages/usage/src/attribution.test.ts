import { describe, expect, it } from "vitest";
import { query, setup } from "./test-support.ts";

type Harness = ReturnType<typeof setup>;
const inputs = (h: Harness, input: unknown) =>
  Object.fromEntries(
    h.store
      .summary(input)
      .rows.map((row) => [
        Object.values(row.dimensions).map(String).join("/"),
        row.totals.inputTokens,
      ]),
  );
const ask = (
  h: Harness,
  skills: string[],
  agent = "root",
  thread = "thread",
  automation?: string,
) =>
  h.send(
    { type: "turn.asked", agent, skills, ...(automation ? { automation } : {}) },
    undefined,
    thread,
  );
const spend = (h: Harness, thread: string, agentId: string, inputTokens: number) =>
  h.send(
    { type: "usage.updated", agentId, inputTokens, outputTokens: 0, counterMode: "incremental" },
    undefined,
    thread,
  );

/** Two skill turns, a plain turn, an automation thread and a delegated child thread. */
function history(h: Harness) {
  h.thread();
  h.agent();
  h.agent("helper", "root");
  ask(h, ["review", "tdd"]);
  spend(h, "thread", "root", 10);
  // A subagent's own prompt carries the turn on; its spend counts for the turn's skills.
  ask(h, [], "helper");
  spend(h, "thread", "helper", 5);
  ask(h, []);
  spend(h, "thread", "root", 7);
  ask(h, ["review"]);
  spend(h, "thread", "root", 1);
  h.thread("nightly");
  h.agent("nightly-root", null, "m", "codex", "nightly");
  ask(h, ["triage"], "nightly-root", "nightly", "automation-1");
  spend(h, "nightly", "nightly-root", 20);
  h.send(
    { type: "thread.created", provider: "codex", workspace: "w", delegated: true },
    undefined,
    "child",
  );
  h.agent("child-root", null, "m", "codex", "child");
  spend(h, "child", "child-root", 40);
}

describe("usage attribution", () => {
  it("a turn that used two skills counts in full under each, until the thread's next ask", () => {
    const h = setup();
    history(h);
    expect(inputs(h, { ...query, groupBy: ["skill"] })).toEqual({
      review: 16,
      tdd: 15,
      triage: 20,
    });
    // Skill rows overlap; the plain total still counts every token once.
    expect(h.totals().inputTokens).toBe(83);
    expect(inputs(h, { ...query, groupBy: ["agent"], filters: { skill: ["tdd"] } })).toEqual({
      root: 10,
      helper: 5,
    });
    expect(
      h.totals({ ...query, filters: { skill: ["review"], thread: ["nightly"] } }).inputTokens,
    ).toBe(0);
    expect(
      h.store
        .series({ ...query, filters: { skill: ["triage"] } })
        .rows.map((row) => [row.dimensions.day, row.totals.inputTokens]),
    ).toEqual([["2026-10-02", 20]]);
  });

  it("groups and filters by the automation that started the thread", () => {
    const h = setup();
    history(h);
    expect(inputs(h, { ...query, groupBy: ["automation"] })).toEqual({
      null: 63,
      "automation-1": 20,
    });
    expect(h.totals({ ...query, filters: { automation: ["automation-1"] } }).inputTokens).toBe(20);
    expect(
      inputs(h, {
        ...query,
        groupBy: ["automation", "skill"],
        filters: { automation: ["automation-1"] },
      }),
    ).toEqual({ "automation-1/triage": 20 });
  });

  it("splits spend into the main agent, its subagents and delegated threads", () => {
    const h = setup();
    history(h);
    expect(inputs(h, { ...query, groupBy: ["role"] })).toEqual({
      main: 38,
      subagent: 5,
      delegated: 40,
    });
    expect(h.totals({ ...query, filters: { role: ["subagent", "delegated"] } }).inputTokens).toBe(
      45,
    );
    expect(inputs(h, { ...query, groupBy: ["role"], filters: { skill: ["review"] } })).toEqual({
      main: 11,
      subagent: 5,
    });
  });

  it("a thread delegated after it spent, or a subagent linked late, is attributed by its link", () => {
    const h = setup();
    h.thread("late");
    h.agent("late-root", null, "m", "codex", "late");
    h.agent("late-helper", null, "m", "codex", "late");
    spend(h, "late", "late-helper", 3);
    h.send({ type: "agent.updated", id: "late-helper", parent: "late-root" }, undefined, "late");
    expect(inputs(h, { ...query, groupBy: ["role"] })).toEqual({ subagent: 3 });
    h.send({ type: "thread.delegated" }, undefined, "late");
    expect(inputs(h, { ...query, groupBy: ["role"] })).toEqual({ delegated: 3 });
  });

  it("skill and automation attribution survive a restart and are gone with a deleted thread", () => {
    const h = setup();
    history(h);
    h.reopen();
    // A turn still open at the restart keeps counting for its skill.
    spend(h, "nightly", "nightly-root", 2);
    expect(inputs(h, { ...query, groupBy: ["skill", "automation"] })).toEqual({
      "review/null": 16,
      "tdd/null": 15,
      "triage/automation-1": 22,
    });
    h.send({ type: "thread.deleted" }, undefined, "nightly");
    expect(inputs(h, { ...query, groupBy: ["skill"] })).toEqual({ review: 16, tdd: 15 });
    expect(h.totals({ ...query, filters: { automation: ["automation-1"] } }).inputTokens).toBe(0);
  });
});
