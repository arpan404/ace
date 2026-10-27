import { expect, test } from "vitest";
import { livePill } from "./live-pill.ts";
import type { TurnActivity } from "./turn-activity.ts";

const working = (extra: Partial<TurnActivity> = {}): TurnActivity => ({
  label: "Working",
  tone: "working",
  elapsedFrom: 1_000,
  current: undefined,
  ...extra,
});
const words = (pill: ReturnType<typeof livePill>) => [
  pill?.status?.label,
  ...(pill?.segments ?? []).map((segment) => segment.label),
];

test("a working root reads Working for its time, sweeping, with nothing to open", () => {
  const pill = livePill({ activity: working(), queued: 0, goal: undefined, requestShown: false });
  expect(pill?.status).toMatchObject({
    label: "Working",
    lead: "Working for",
    since: 1_000,
    live: true,
  });
  expect(pill?.status?.opens).toBeUndefined();
  expect(pill?.segments).toEqual([]);
});

test("subagents and commands working beside the root join the pill and open the agent tree", () => {
  const pill = livePill({
    activity: working({ subagents: 2, backgroundCommands: 1 }),
    queued: 2,
    goal: undefined,
    requestShown: false,
  });
  expect(words(pill)).toEqual(["Working", "2 subagents", "1 command", "2 queued"]);
  expect(pill?.segments.map((segment) => segment.opens)).toEqual(["agents", "agents", "queue"]);
});

test("a root that only waits on its subagents says how many, never Working, and opens them", () => {
  const pill = livePill({
    activity: working({
      label: "Waiting for 2 subagents",
      waitingOnSubagents: true,
      subagents: 2,
      backgroundCommands: 1,
      waitingOn: { kind: "subagents", count: 2, turnOver: false, commands: 1 },
    }),
    queued: 2,
    goal: undefined,
    requestShown: false,
  });
  expect(words(pill)).toEqual(["Waiting on 2", "1 command", "2 queued"]);
  expect(pill?.status).toMatchObject({ live: false, opens: "agents" });
});

test("a turn over with only a background command left names that command", () => {
  const pill = livePill({
    activity: working({
      label: "Running in background",
      backgroundCommands: 1,
      waitingOn: {
        kind: "background",
        count: 1,
        title: "bun run dev",
        shells: true,
        taskIds: ["t1"],
      },
    }),
    queued: 0,
    goal: undefined,
    requestShown: false,
  });
  expect(pill?.status).toMatchObject({
    label: "Running",
    code: "bun run dev",
    live: false,
    opens: "agents",
  });
  // The status already names the command: it isn't counted again.
  expect(pill?.segments).toEqual([]);
});

test("a request card in the strip takes the pill's place, queue and goal included", () => {
  const asking = working({
    tone: "needs-you",
    label: "Waiting for your approval",
    elapsedFrom: undefined,
  });
  const goal = { objective: "ship", status: "active" as const };
  expect(livePill({ activity: asking, queued: 1, goal, requestShown: true })).toBeUndefined();
});

test("a tree waiting on the person with no card here keeps saying so, naming who asks", () => {
  const asking = working({
    tone: "needs-you",
    label: "Waiting for your answer",
    elapsedFrom: undefined,
    asker: "reviewer",
  });
  const pill = livePill({ activity: asking, queued: 0, goal: undefined, requestShown: false });
  expect(pill?.status).toMatchObject({
    label: "Waiting for your answer · reviewer",
    tone: "needs-you",
    opens: "agents",
  });
});

test("a goal shows between turns on its own, and sweeps only while the thread works on it", () => {
  const goal = { objective: "all tests pass", status: "active" as const };
  const idle = livePill({ activity: undefined, queued: 0, goal, requestShown: false });
  expect(idle?.status).toBeUndefined();
  expect(idle?.segments).toEqual([
    { kind: "goal", label: "Pursuing goal", opens: "goal", live: false },
  ]);
  expect(
    livePill({ activity: working(), queued: 0, goal, requestShown: false })?.segments[0]?.live,
  ).toBe(true);
  const paused = livePill({
    activity: working(),
    queued: 0,
    goal: { ...goal, status: "paused" },
    requestShown: false,
  });
  expect(paused?.segments[0]).toMatchObject({ label: "Goal paused", live: false });
});

test("nothing live, queued or pursued: no pill", () => {
  expect(
    livePill({ activity: undefined, queued: 0, goal: null, requestShown: false }),
  ).toBeUndefined();
});

test("while the strip says what holds the turn the pill keeps its counts but not the words", () => {
  const activity = working();
  expect(
    livePill({ activity, queued: 2, goal: undefined, requestShown: false })?.status,
  ).toBeDefined();
  const held = livePill({
    activity,
    queued: 2,
    goal: undefined,
    requestShown: false,
    holdShown: true,
  });
  expect(held?.status).toBeUndefined();
  expect(held?.segments.map((segment) => segment.label)).toEqual(["2 queued"]);
  expect(
    livePill({ activity, queued: 0, goal: undefined, requestShown: false, holdShown: true }),
  ).toBeUndefined();
});
