import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * A turn's transcript follows its whole agent tree: it never folds into "Worked for" while a
 * subagent it launched still works, and it folds once the last one ends. Over the real SDK and
 * the fake daemon (`thread-harness.ts`); no provider CLI runs.
 */

afterEach(reset);

const kinds = () =>
  rows("thread.block")
    .toSorted((a, b) => Number(a.index) - Number(b.index))
    .map((row) => String(row.kind));
const head = () =>
  rows("thread.block").find((row) => row.kind === "work") as
    | { work: { label: string; outcome: string } }
    | undefined;

test("a turn that ended while its subagent works stays live, then folds once the subagent ends", async () => {
  const fake = fixture();
  fake.createThread({ id: "tree", workspaceId: "ace", title: "Tree", provider: "codex" });
  fake.apply("tree", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Review it."),
    facts.message("root", "split", "assistant", "Handing the review to an agent."),
    facts.tool("root", "spawn", {
      kind: "agent.spawn",
      title: "Reviewer",
      detail: { kind: "agent.spawn", description: "Reviewer" },
    }),
    facts.toolDone("root", "spawn"),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("root"),
  ]);
  open(connect(fake), "tree");
  await until(() => kinds().includes("subagents"), "the subagent rollup");
  expect(kinds()).toEqual(["user", "live", "message", "subagents"]);
  expect(head()).toBeUndefined();

  fake.apply("tree", [facts.endTurn("reviewer")]);
  const folded = await until(() => head()?.work.outcome === "completed" && head(), "the head");
  expect(folded.work.label).toMatch(/^Worked for /);
  expect(kinds()).not.toContain("live");
});
