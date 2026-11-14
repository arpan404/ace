import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { commands, connect, fixture, latest, open, reset, until } from "./thread-harness.ts";

/*
 * The live pill over the composer and the goal's sheet, over the real SDK and an in-process fake
 * daemon. No provider CLI runs.
 */

afterEach(reset);

type Status = { label: string; lead: string; since: number | null; live: boolean; opens: string };
type Segment = { kind: string; label: string; opens: string; live: boolean };
type Goal = {
  title: string;
  objective: string;
  reason: string;
  canPause: boolean;
  canResume: boolean;
  canClear: boolean;
};
const pill = () =>
  latest("thread.pill")?.pill as { status: Status | null; segments: Segment[] } | null | undefined;
const goal = () => latest("thread.pill")?.goal as Goal | null | undefined;

test("a running turn's pill reads Working for its time and sweeps", async () => {
  const fake = fixture();
  fake.createThread({ id: "run", workspaceId: "ace", title: "Run", provider: "codex" });
  fake.apply("run", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  open(connect(fake), "run");
  const status = await until(() => pill()?.status ?? undefined, "the pill");
  expect(status).toMatchObject({ label: "Working", lead: "Working for", live: true, opens: "" });
  expect(status.since).toBeTypeOf("number");
});

test("a parent that only waits on its subagent says so on the pill, which opens the agent tree", async () => {
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
  const status = await until(() => pill()?.status ?? undefined, "the pill");
  expect(status).toMatchObject({ label: "Waiting on 1", live: false, opens: "agents" });
});

test("a goal shows on the pill between turns, and its sheet pauses and clears it where ace can", async () => {
  const fake = fixture();
  fake.createThread({ id: "goal", workspaceId: "ace", title: "Goal", provider: "codex" });
  fake.apply("goal", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  fake.updateThread("goal", {
    goal: {
      objective: "all tests pass",
      status: "active",
      checks: 2,
      lastReason: "two still fail",
    },
  });
  const session = open(connect(fake), "goal");
  const segments = await until(
    () => pill()?.segments.length && pill()?.segments,
    "the goal on the pill",
  );
  // Its progress rides on the pill, as the web's goal strip shows it beside the status.
  expect(segments).toEqual([
    { kind: "goal", label: "Pursuing goal", detail: "2 checks", opens: "goal", live: false },
  ]);
  expect(goal()).toMatchObject({
    title: "Pursuing goal",
    objective: "all tests pass",
    reason: "Not met yet: two still fail",
    canPause: true,
    canResume: false,
    canClear: true,
  });

  session.handle({ type: "goal", change: "pause", requestId: "pause" });
  await until(() => goal()?.title === "Goal paused", "the paused goal");
  expect(commands("thread.goal.set").at(-1)).toMatchObject({ change: { status: "paused" } });
  expect(goal()).toMatchObject({ canPause: false, canResume: true });

  session.handle({ type: "goal", change: "clear", requestId: "clear" });
  await until(() => latest("thread.pill")?.goal === null, "the cleared goal");
  expect(pill()).toBeNull();
});

test("a goal the provider keeps itself offers no changes, and a change sent anyway goes nowhere", async () => {
  const fake = fixture();
  fake.createThread({ id: "own", workspaceId: "ace", title: "Own", provider: "claude" });
  fake.apply("own", [facts.rootAgent("claude"), facts.turn("root"), facts.endTurn("root")]);
  fake.updateThread("own", { goal: { objective: "ship it", status: "active" } });
  const session = open(connect(fake), "own");
  const row = await until(() => goal(), "the goal");
  expect(row).toMatchObject({ canPause: false, canResume: false, canClear: false });
  session.handle({ type: "goal", change: "clear", requestId: "clear" });
  const refused = await until(() => latest("admission", "clear"), "the refusal");
  expect(refused).toMatchObject({ ok: false });
  expect(commands("thread.goal.clear")).toEqual([]);
});

test("a request card takes the pill's place while it is open, and the pill comes back after", async () => {
  const fake = fixture();
  fake.createThread({ id: "ask", workspaceId: "ace", title: "Ask", provider: "codex" });
  fake.apply("ask", [facts.rootAgent("codex"), facts.turn("root")]);
  fake.updateThread("ask", { goal: { objective: "ship it", status: "active" } });
  open(connect(fake), "ask");
  await until(() => pill()?.status, "the working pill");
  fake.apply("ask", [
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "tabs",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "tabs",
            text: "Tabs or spaces?",
            multiSelect: false,
            allowOther: false,
            secret: false,
            options: [{ id: "tabs", label: "Tabs" }],
          },
        ],
      },
    },
  ]);
  // The goal and everything else step aside with the status: the card is what needs the person.
  await until(() => latest("thread.pill") && pill() === null, "the pill stepping aside");
  fake.apply("ask", [
    {
      type: "interaction.closed",
      interaction: "tabs",
      state: "resolved",
      resolution: { kind: "question", answers: { tabs: ["tabs"] } },
    },
  ]);
  const back = await until(
    () => (pill()?.segments.length ? pill() : undefined),
    "the pill coming back",
  );
  expect(back?.segments.map((segment) => segment.kind)).toEqual(["goal"]);
});

const leftRunning = () =>
  latest("thread.pill")?.leftRunning as
    | { strip: { sentence: string; payload: string; lead: unknown }; taskIds: string[] }
    | null
    | undefined;

function relay(stopped: boolean) {
  return [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Start the relay."),
    facts.tool("root", "relay", {
      kind: "shell",
      title: "bun run dev:relay",
      detail: { kind: "shell", command: "bun run dev:relay" },
    }),
    {
      type: "background.started" as const,
      agent: "root",
      task: "relay",
      kind: "shell" as const,
      title: "bun run dev:relay",
      item: "relay",
      stoppable: true,
    },
    ...(stopped ? [facts.endTurn("root", "interrupted")] : []),
  ];
}

test("a command a stopped turn left running shows on the strip with its command and one Stop", async () => {
  const fake = fixture();
  fake.createThread({ id: "stopped", workspaceId: "ace", title: "Relay", provider: "claude" });
  fake.apply("stopped", relay(true));
  open(connect(fake), "stopped");
  const left = await until(() => leftRunning() ?? undefined, "what the stop left running");
  expect(left.strip).toMatchObject({
    lead: { icon: "background", tone: "background" },
    sentence: "Running",
    payload: "bun run dev:relay",
  });
  expect(left.taskIds).toHaveLength(1);
});

test("while the turn still works, nothing is said to be left running", async () => {
  const fake = fixture();
  fake.createThread({ id: "busy", workspaceId: "ace", title: "Relay", provider: "claude" });
  fake.apply("busy", relay(false));
  open(connect(fake), "busy");
  await until(() => pill()?.status ?? undefined, "the pill");
  expect(leftRunning()).toBeNull();
});
