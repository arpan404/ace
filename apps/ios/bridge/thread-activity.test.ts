import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

/*
 * The live capsule's line over the real SDK and an in-process fake daemon. No provider CLI runs.
 */

afterEach(reset);

type Activity = { label: string; tone: string; since: number | null; commands: string } | null;
const activity = () => latest("thread.activity")?.row as Activity | undefined;

test("a running turn reads Working with a timer", async () => {
  const fake = fixture();
  fake.createThread({ id: "run", workspaceId: "ace", title: "Run", provider: "codex" });
  fake.apply("run", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  open(connect(fake), "run");
  const row = await until(() => activity(), "the live line");
  expect(row).toMatchObject({ label: "Working", tone: "working" });
  expect(row?.since).toBeTypeOf("number");
});

test("a parent whose turn ended still reads as waiting while its subagent works", async () => {
  const fake = fixture();
  fake.createThread({ id: "tree", workspaceId: "ace", title: "Tree", provider: "codex" });
  fake.apply("tree", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Review it."),
    facts.tool("root", "spawn", {
      kind: "agent.spawn",
      title: "Review PID reuse",
      detail: { kind: "agent.spawn", description: "Review PID reuse", childAgent: "reviewer" },
    }),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("root"),
  ]);
  open(connect(fake), "tree");
  const row = await until(() => activity(), "the live line");
  expect(row).toMatchObject({ label: "Waiting on 1", tone: "working" });
});

test("a settled thread has no live line", async () => {
  const fake = fixture();
  fake.createThread({ id: "done", workspaceId: "ace", title: "Done", provider: "codex" });
  fake.apply("done", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
    facts.message("root", "answer", "assistant", "Done."),
    facts.endTurn("root"),
  ]);
  open(connect(fake), "done");
  await until(() => latest("thread.activity"), "the live line");
  expect(activity()).toBeNull();
});
