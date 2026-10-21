import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { OffshiftRequest, OffshiftRun } from "@ace/protocol/offshift";
import { playbookCatalogue, runCard, transition, view, type Context } from "./index.ts";

const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000001");
const context: Context = {
  threadId,
  caller: { threadId, provider: "codex", model: "gpt-5" },
  now: 10,
  revision: "r1",
  treeState: "done",
};
const start = (extra: Partial<Extract<OffshiftRequest, { action: "start" }>> = {}) =>
  transition(
    undefined,
    {
      action: "start",
      runId: "login",
      outcome: "A wrong password shows an error",
      endpoint: "Verified local change",
      criteria: [{ id: "error", description: "The error shows", requiredKinds: ["automated"] }],
      ...extra,
    },
    context,
  );
const change = (run: OffshiftRun, request: Record<string, unknown>) =>
  transition(run, { runId: run.id, version: run.version, ...request } as OffshiftRequest, context);
const advance = (run: OffshiftRun, phase: OffshiftRun["phase"]) =>
  change(run, { action: "advance", phase, note: `To ${phase}` });
const mark = (run: OffshiftRun, stepId: string, state: "done" | "skipped", note?: string) =>
  change(run, { action: "step", stepId, state, ...(note ? { note } : {}) });
const pass = (run: OffshiftRun) =>
  change(run, {
    action: "evidence",
    evidence: [
      {
        criterionId: "error",
        kind: "automated",
        result: "pass",
        revision: "r1",
        action: "Ran the login test",
        artifact: "test log",
        note: "Passes",
      },
    ],
  });

test("a run started from a playbook carries its steps, all to do, and next names the first", () => {
  const run = start({ playbook: "fix" });
  const fix = playbookCatalogue().playbooks.find((item) => item.id === "fix");
  expect(run.playbook).toBe("fix");
  expect(run.steps.map((step) => step.id)).toEqual(fix?.steps.map((step) => step.id));
  expect(run.steps.every((step) => step.state === "todo")).toBe(true);
  expect(view(run, context).next).toBe(
    "Step `reproduce`: Reproduce the defect on the surface where it was reported. Then call step: done with what you observed, or skipped with the reason (1 more step in plan). Use version 0.",
  );
});

test("custom steps join a playbook's in phase order, and a reused id or too many steps is refused", () => {
  const run = start({
    playbook: "fix",
    steps: [
      { id: "bisect", title: "Bisect to the commit that broke it", phase: "plan" },
      { id: "changelog", title: "Add a changelog line", phase: "delivery" },
    ],
  });
  expect(run.steps.filter((step) => step.phase === "plan").map((step) => step.id)).toEqual([
    "reproduce",
    "root-cause",
    "bisect",
  ]);
  expect(run.steps.at(-1)?.id).toBe("changelog");
  expect(() =>
    start({ playbook: "fix", steps: [{ id: "reproduce", title: "Again", phase: "plan" }] }),
  ).toThrow("Step id reproduce is used twice");
  const many = Array.from({ length: 20 }, (_, index) => ({
    id: `s${index}`,
    title: "Extra",
    phase: "verify" as const,
  }));
  expect(() => start({ playbook: "fix", steps: many })).toThrow("at most 24 steps");
});

test("a run without a playbook can track its own steps", () => {
  const run = start({ steps: [{ id: "sketch", title: "Sketch the schema", phase: "plan" }] });
  expect(run.playbook).toBeUndefined();
  expect(view(run, context).next).toBe(
    "Step `sketch`: Sketch the schema. Then call step: done with what you observed, or skipped with the reason. Use version 0.",
  );
  const done = mark(run, "sketch", "done", "Two tables");
  expect(view(done, context).next).toBe("Advance to implement. Use version 1.");
});

test("leaving a phase is refused while it has steps to do, and allowed once each is done or skipped with a reason", () => {
  let run = start({ playbook: "fix" });
  expect(() => advance(run, "implement")).toThrow(
    "Finish plan first: 2 steps to do (reproduce, root-cause)",
  );
  run = mark(run, "reproduce", "done", "Saw the blank error box in the login page");
  expect(() => mark(run, "root-cause", "skipped")).toThrow(
    "Skipping root-cause needs a note with the reason",
  );
  run = mark(run, "root-cause", "skipped", "The reproduction already shows the cause");
  run = advance(run, "implement");
  expect(run.phase).toBe("implement");
  expect(run.steps.find((step) => step.id === "root-cause")).toMatchObject({
    state: "skipped",
    note: "The reproduction already shows the cause",
  });
});

test("a step of a later phase waits for that phase, and an unknown step names the run's steps", () => {
  const run = start({ playbook: "investigate" });
  expect(() => mark(run, "gather", "done", "Read it")).toThrow(
    "Step gather belongs to verify; advance there first",
  );
  expect(() => mark(run, "nope", "done", "x")).toThrow(
    "No step nope in this run; its steps are question, gather, counter, cited-answer",
  );
});

test("investigate has no implement steps, so implement can be left at once", () => {
  let run = start({ playbook: "investigate" });
  run = advance(mark(run, "question", "done", "Why the cache misses"), "implement");
  expect(view(run, context).next).toBe("Advance to verify. Use version 2.");
  expect(advance(run, "verify").phase).toBe("verify");
});

test("returning to an earlier phase keeps its done steps", () => {
  let run = start({ steps: [{ id: "sketch", title: "Sketch", phase: "plan" }] });
  run = advance(mark(run, "sketch", "done", "Drawn"), "implement");
  run = advance(run, "plan");
  expect(run.steps[0]?.state).toBe("done");
  expect(advance(run, "implement").phase).toBe("implement");
});

test("a delivered run with a delivery step to do is not complete until the step is marked", () => {
  let run = start({ steps: [{ id: "report", title: "Report with evidence", phase: "delivery" }] });
  for (const phase of ["implement", "verify", "review"] as const) run = advance(run, phase);
  run = advance(pass(run), "delivery");
  expect(view(run, context).state).toBe("active");
  expect(view(run, context).next).toContain("Step `report`");
  run = mark(run, "report", "done", "Reported");
  expect(view(run, context).state).toBe("complete");
});

test("the card lists the current phase's steps with a skipped step's reason, clipped", () => {
  let run = start({ playbook: "fix" });
  run = mark(run, "reproduce", "skipped", `No access to production. ${"x".repeat(400)}`);
  const card = runCard(run, "r1");
  expect(card.steps.map((step) => [step.id, step.state])).toEqual([
    ["reproduce", "skipped"],
    ["root-cause", "todo"],
  ]);
  expect(card.steps[0]?.reason?.startsWith("No access to production.")).toBe(true);
  expect(card.steps[0]?.reason?.length).toBe(160);
  expect(card.steps[1]?.reason).toBeUndefined();
});
