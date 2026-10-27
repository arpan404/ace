import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { MobileOffshift } from "@ace/ui-core/mobile";
import { blockedCard, deliveredCard } from "../scripts/offshift-card.ts";
import { connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

/* The open thread's Offshift run over the real SDK and an in-process fake daemon. */

afterEach(reset);

const run = () => latest("thread.offshift")?.run as MobileOffshift | null | undefined;

test("a delivered run never reads Done while a subagent still works, and does once the tree settles", async () => {
  const fake = fixture();
  fake.createThread({ id: "run", workspaceId: "ace", title: "Run", provider: "codex" });
  fake.apply("run", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.subagent("codex", "checker", "Checker", "spawn"),
    facts.turn("checker", "spawn"),
    facts.endTurn("root"),
  ]);
  fake.updateOffshift("run", deliveredCard(1000));
  open(connect(fake), "run");
  const working = await until(() => run() ?? undefined, "the run");
  expect(working.word).toBe("Working");
  expect(working.done).toBe(false);
  expect(working.phase).toBe("Fix · Delivery · 5 of 5");
  fake.apply("run", [facts.endTurn("checker")]);
  const done = await until(() => (run()?.done ? run() : undefined), "the settled run");
  expect(done?.word).toBe("Done");
  expect(done?.token).toBe("done");
});

test("a blocked run shows its blocker, steps and each criterion's checks and who recorded them", async () => {
  const fake = fixture();
  fake.createThread({ id: "held", workspaceId: "ace", title: "Held", provider: "codex" });
  fake.apply("held", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  fake.updateOffshift("held", blockedCard(1000));
  open(connect(fake), "held");
  const held = await until(() => run() ?? undefined, "the run");
  expect(held.word).toBe("Waiting");
  expect(held.blocker).toContain("Linux runner is offline");
  expect(held.steps.map((step) => step.state)).toEqual(["Done", "To do", "Skipped"]);
  expect(held.steps[2]?.reason).toBe("Not part of this fix");
  const reuse = held.criteria.find((criterion) => criterion.id === "reuse");
  expect(reuse?.state).toBe("Failed");
  expect(reuse?.needs).toEqual([{ kind: "Independent Automated", failed: true }]);
  expect(reuse?.evidence[1]).toMatch(/^Source review · Passed · Claude/);
  expect(held.pending).toBe(2);
  expect(held.next).toContain("Resolve the blocker");
});

test("a delivered run whose tree only waits on a usage limit reads Waiting, not Working or Done", async () => {
  const fake = fixture();
  fake.createThread({ id: "limit", workspaceId: "ace", title: "Limit", provider: "claude" });
  fake.apply("limit", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.subagent("claude", "checker", "Checker", "spawn"),
    facts.turn("checker", "spawn"),
    facts.endTurn("checker", "failed", { kind: "quota", message: "Usage limit reached" }),
    facts.endTurn("root"),
  ]);
  fake.updateOffshift("limit", deliveredCard(1000));
  open(connect(fake), "limit");
  const waiting = await until(() => run() ?? undefined, "the run");
  expect(waiting.word).toBe("Waiting");
  expect(waiting.done).toBe(false);
});
