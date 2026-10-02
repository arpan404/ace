import { describe, expect, it } from "vitest";
import { apply, recover } from "./index.ts";
import { artifact, check, complete, fact, setup } from "./test-support.ts";

describe("orchestration lifecycle", () => {
  it("three providers fan out the same prompt and retain two successes after one fails", () => {
    const r = setup();
    expect(r.initial.intents.map((i) => i.effect.type === "start" && i.effect.prompt)).toEqual([
      r.input.prompt,
      r.input.prompt,
      r.input.prompt,
    ]);
    const [a, b, c] = r.lanes;
    if (!a || !b || !c) throw new Error("Missing lanes");
    r.send({ type: "thread", ...fact(b), status: { state: "failed" } });
    complete(r.state, a, r.ctx);
    check(r.state, a, r.ctx);
    expect(r.state.status).toBe("running");
    complete(r.state, c, r.ctx);
    const result = check(r.state, c, r.ctx);
    expect(result.events).toContainEqual({
      type: "orchestration.status",
      orchestrationId: r.state.id,
      runId: r.state.runId,
      status: "succeeded",
    });
    expect(b.phase).toBe("failed");
    expect(a.phase).toBe("succeeded");
    expect(c.phase).toBe("succeeded");
  });
  it("a race rejects a failed check, selects the first passing lane and waits for losers to stop", () => {
    const r = setup("race");
    const [a, b, c] = r.lanes;
    if (!a || !b || !c) throw new Error("Missing lanes");
    complete(r.state, a, r.ctx);
    check(r.state, a, r.ctx, false);
    expect(r.state.winner).toBeUndefined();
    complete(r.state, b, r.ctx);
    expect(r.state.winner).toBeUndefined();
    const result = check(r.state, b, r.ctx);
    expect(r.state.winner).toBe(b.id);
    expect(result.intents.map((i) => i.effect)).toEqual([{ type: "cancel", ...fact(c) }]);
    expect(r.state.status).toBe("cancelling");
    r.send({ type: "thread", ...fact(c), status: { state: "done" } });
    expect(r.state.status).toBe("cancelling");
    r.send({ type: "stopped", ...fact(c) });
    expect(r.state.status).toBe("succeeded");
    expect(c.phase).toBe("cancelled");
  });
  it("implement, review and fix stages receive the previous checked artifact", () => {
    const r = setup("pipeline");
    const [implement, review, fix] = r.lanes;
    if (!implement || !review || !fix) throw new Error("Missing lanes");
    expect(r.initial.intents).toHaveLength(1);
    complete(r.state, implement, r.ctx);
    expect(Object.values(r.state.intents).filter((i) => i.effect.type === "start")).toHaveLength(1);
    const first = check(r.state, implement, r.ctx);
    expect(first.intents.map((i) => i.effect)).toEqual([
      {
        type: "start",
        ...fact(review),
        prompt: review.prompt,
        spec: review.spec,
        input: artifact,
      },
    ]);
    const revised = {
      ...artifact,
      summary: "Reviewer found missing guard",
      checkpoint: "refs/ace/checkpoints/review/1",
    };
    complete(r.state, review, r.ctx, revised);
    expect(check(r.state, review, r.ctx).intents.map((i) => i.effect)).toEqual([
      { type: "start", ...fact(fix), prompt: fix.prompt, spec: fix.spec, input: revised },
    ]);
    complete(r.state, fix, r.ctx);
    check(r.state, fix, r.ctx);
    expect(r.state.status).toBe("succeeded");
  });
  it("a failed pipeline cancels unstarted downstream stages without running them", () => {
    const r = setup("pipeline");
    const a = r.lanes[0];
    if (!a) throw new Error("Missing lane");
    r.send({ type: "thread", ...fact(a), status: { state: "failed" } });
    expect(r.state.status).toBe("failed");
    expect(r.lanes.slice(1).map((l) => l.phase)).toEqual(["cancelled", "cancelled"]);
    expect(Object.values(r.state.intents)).toEqual([]);
  });
  it("human approvals and background work hold the run open until aggregate done and checks", () => {
    const r = setup("fanout", 1);
    const a = r.lanes[0];
    if (!a) throw new Error("Missing lane");
    r.send({ type: "artifact", ...fact(a), artifact });
    r.send({ type: "thread", ...fact(a), status: { state: "needs_you", interactions: 1 } });
    expect(r.state.status).toBe("waiting");
    r.send({ type: "thread", ...fact(a), status: { state: "waiting", on: "background_task" } });
    expect(a.phase).toBe("waiting");
    expect(Object.values(r.state.intents).some((i) => i.effect.type === "check")).toBe(false);
    r.send({ type: "thread", ...fact(a), status: { state: "done" } });
    expect(a.phase).toBe("checking");
    expect(r.state.status).toBe("running");
    check(r.state, a, r.ctx);
    expect(r.state.status).toBe("succeeded");
  });
  it("idle without an artifact cannot pass success criteria", () => {
    const r = setup("fanout", 1);
    const a = r.lanes[0];
    if (!a) throw new Error("Missing lane");
    r.send({ type: "thread", ...fact(a), status: { state: "done" } });
    expect(a.phase).toBe("collecting");
    expect(r.state.status).toBe("running");
    expect(r.send({ type: "artifact", ...fact(a), artifact }).intents[0]?.effect.type).toBe(
      "check",
    );
  });
  it("an optional agent review must pass even when the command succeeds", () => {
    const r = setup("fanout", 1);
    r.state.input.template.checks.review = "Check correctness";
    const a = r.lanes[0];
    if (!a) throw new Error("Missing lane");
    const entry = complete(r.state, a, r.ctx).intents[0];
    if (!entry) throw new Error("Missing check");
    r.send({ type: "checked", ...fact(a), intentId: entry.id, commandPassed: true });
    expect(r.state.status).toBe("failed");
  });
  it("late check results cannot finish a thread that resumed work", () => {
    const r = setup("fanout", 1);
    const a = r.lanes[0];
    if (!a) throw new Error("Missing lane");
    const old = complete(r.state, a, r.ctx).intents[0];
    if (!old) throw new Error("Missing check");
    r.send({ type: "thread", ...fact(a), status: { state: "working", agents: 1 } });
    r.send({ type: "checked", ...fact(a), intentId: old.id, commandPassed: true });
    expect(a.phase).toBe("working");
    const next = complete(r.state, a, r.ctx).intents[0];
    if (!next) throw new Error("Missing check");
    r.send({ type: "checked", ...fact(a), intentId: old.id, commandPassed: true });
    expect(a.phase).toBe("checking");
    check(r.state, a, r.ctx);
    expect(r.state.status).toBe("succeeded");
  });
  it("new work reopens a previously successful lane", () => {
    const r = setup("fanout", 1);
    const a = r.lanes[0];
    if (!a) throw new Error("Missing lane");
    complete(r.state, a, r.ctx);
    check(r.state, a, r.ctx);
    r.send({ type: "thread", ...fact(a), status: { state: "waiting", on: "background_task" } });
    expect(r.state.status).toBe("waiting");
    expect(a.phase).toBe("waiting");
  });
  it("restart replays the original pending checks and cancellation intents", () => {
    const r = setup("race", 2);
    const [a, b] = r.lanes;
    if (!a || !b) throw new Error("Missing lanes");
    complete(r.state, a, r.ctx);
    const loaded = recover(JSON.parse(JSON.stringify(r.state)));
    expect(loaded.intents).toEqual(Object.values(r.state.intents));
    const loadedA = loaded.state.lanes[a.id];
    if (!loadedA) throw new Error("Missing lane");
    check(loaded.state, loadedA, r.ctx);
    const recovered = recover(JSON.parse(JSON.stringify(loaded.state)));
    expect(recovered.intents.map((i) => i.effect.type)).toEqual(["cancel"]);
    apply(recovered.state, { type: "stopped", ...fact(b) }, r.ctx);
    expect(recovered.state.status).toBe("succeeded");
    expect(recover(JSON.parse(JSON.stringify(recovered.state))).intents).toEqual([]);
  });
  it("recovery rejects a snapshot that hides unfinished descendants", () => {
    const r = setup();
    const input = JSON.parse(JSON.stringify(r.state));
    input.open = 0;
    expect(() => recover(input)).toThrow("Invalid lifecycle counters");
  });
});
