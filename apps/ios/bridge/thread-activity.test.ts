import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

/*
 * The thread's live line and the composer strip's words over the real SDK and an in-process fake
 * daemon. No provider CLI runs.
 */

afterEach(reset);

type Wait = { label: string; code: string; detail: string; stop: string; taskIds: string[] };
type Activity = {
  lead: string;
  tone: string;
  since: number | null;
  inline: boolean;
  wait: Wait | null;
} | null;
const activity = () => latest("thread.activity")?.row as Activity | undefined;

/** A root that started a subagent and ended its own turn, leaving the subagent working. */
const waitingTree = [
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
];

test("a running turn reads Working for its time at the top of the turn", async () => {
  const fake = fixture();
  fake.createThread({ id: "run", workspaceId: "ace", title: "Run", provider: "codex" });
  fake.apply("run", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  open(connect(fake), "run");
  const row = await until(() => activity(), "the live line");
  expect(row).toMatchObject({ lead: "Working for", tone: "working", inline: true, wait: null });
  expect(row?.since).toBeTypeOf("number");
});

test("a parent whose turn ended waits for its subagent in the strip, which stops the tree", async () => {
  const fake = fixture();
  fake.createThread({ id: "tree", workspaceId: "ace", title: "Tree", provider: "codex" });
  fake.apply("tree", [...waitingTree, facts.endTurn("root")]);
  open(connect(fake), "tree");
  const row = await until(() => activity(), "the live line");
  // The inline line steps aside: the strip says what the main agent waits on.
  expect(row).toMatchObject({ inline: false, tone: "working" });
  expect(row?.wait).toMatchObject({ label: "Waiting for 1 subagent", detail: "", stop: "tree" });
});

test("the strip counts a command the parent left running beside its subagent", async () => {
  const fake = fixture();
  fake.createThread({ id: "relay", workspaceId: "ace", title: "Relay", provider: "codex" });
  fake.apply("relay", [
    ...waitingTree,
    facts.tool("root", "serve", {
      kind: "shell",
      title: "Run the relay",
      detail: { kind: "shell", command: "bun run dev:relay" },
    }),
    {
      type: "background.started",
      agent: "root",
      task: "relay",
      item: "serve",
      kind: "shell",
      title: "bun run dev:relay",
      stoppable: true,
    },
    facts.endTurn("root"),
  ]);
  open(connect(fake), "relay");
  const row = await until(() => activity()?.wait?.detail || undefined, "the command count");
  expect(row).toBe("1 command running");
  expect(activity()?.wait?.label).toBe("Waiting for 1 subagent");
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
