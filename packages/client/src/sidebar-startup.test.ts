import { expect, test } from "vitest";
import {
  listStartup,
  stepStartup,
  type ListStartup,
  type StartupInput,
} from "./sidebar-startup.ts";

/** Run `inputs` from a fresh, kept list on `filter`; every subscribe they cause, in order. */
function run(inputs: readonly StartupInput[], filter = "all", kept = true) {
  let state: ListStartup = listStartup(filter, { kept, welcomed: false, connected: false });
  const subscribes: string[] = [];
  for (const input of inputs) {
    const step = stepStartup(state, input);
    state = step.state;
    if (step.subscribe !== undefined) subscribes.push(step.subscribe);
  }
  return { state, subscribes };
}
const ready: StartupInput[] = [{ type: "held" }, { type: "connected" }];

test.each<[string, StartupInput[], string[]]>([
  ["held and connected, the read still out: waits", [...ready], []],
  ["the read settles: subscribes", [...ready, { type: "read", filter: "all" }], ["all"]],
  ["the deadline without the welcome: waits", [...ready, { type: "deadline" }], []],
  ["the welcome without the deadline: waits", [...ready, { type: "welcome" }], []],
  [
    "the deadline and the welcome, in either order: subscribes",
    [...ready, { type: "welcome" }, { type: "deadline" }],
    ["all"],
  ],
  [
    "the deadline, then the welcome: subscribes at the welcome",
    [...ready, { type: "deadline" }, { type: "welcome" }],
    ["all"],
  ],
  [
    "the read settles before the list is held: subscribes once held",
    [{ type: "connected" }, { type: "read", filter: "all" }, { type: "held" }],
    ["all"],
  ],
  [
    "the read settles before the socket is up: subscribes once it is",
    [{ type: "held" }, { type: "read", filter: "all" }, { type: "connected" }],
    ["all"],
  ],
  [
    "disconnected before the read settles: waits for the next socket",
    [...ready, { type: "disconnected" }, { type: "read", filter: "all" }],
    [],
  ],
  [
    "released before the read settles: waits until held again",
    [...ready, { type: "released" }, { type: "read", filter: "all" }, { type: "held" }],
    ["all"],
  ],
  [
    "a read for a filter that is no longer current is ignored",
    [...ready, { type: "filter", filter: "selected" }, { type: "read", filter: "all" }],
    [],
  ],
  [
    "the current filter's read subscribes for it",
    [...ready, { type: "filter", filter: "selected" }, { type: "read", filter: "selected" }],
    ["selected"],
  ],
  [
    "the same filter again keeps its settled read",
    [
      { type: "held" },
      { type: "read", filter: "all" },
      { type: "filter", filter: "all" },
      { type: "connected" },
    ],
    ["all"],
  ],
])("%s", (_case, inputs, subscribes) => {
  expect(run(inputs).subscribes).toEqual(subscribes);
});

test("a list kept nowhere subscribes as soon as it is held and connected", () => {
  expect(run([...ready], "all", false).subscribes).toEqual(["all"]);
});

test("a filter change never moves the deadline set at opening", () => {
  // The deadline passed before the change, and the welcome came: the change subscribes at once.
  const { subscribes } = run([
    ...ready,
    { type: "deadline" },
    { type: "welcome" },
    { type: "filter", filter: "selected" },
  ]);
  // The deadline and welcome already settled the wait for "all", so it subscribed for it.
  expect(subscribes).toEqual(["all"]);
  const before = run([...ready, { type: "deadline" }, { type: "filter", filter: "selected" }]);
  if (before.state.phase !== "waiting") throw new Error("Subscribed early");
  expect(before.state.deadline).toBe(true);
  expect(stepStartup(before.state, { type: "welcome" }).subscribe).toBe("selected");
});

test("once subscribed, nothing makes the list subscribe again", () => {
  const { state } = run([...ready, { type: "read", filter: "all" }]);
  for (const input of [
    { type: "filter", filter: "selected" },
    { type: "read", filter: "selected" },
    { type: "deadline" },
    { type: "welcome" },
    { type: "disconnected" },
    { type: "connected" },
  ] satisfies StartupInput[])
    expect(stepStartup(state, input).subscribe).toBeUndefined();
});

/** A small deterministic generator: the same seed gives the same sequence. */
function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("any sequence of filter changes, reads and events yields one subscribe, for the filter current then", () => {
  const filters = ["all", "archive", "web", "web-archive", "relay"];
  for (let seed = 1; seed <= 500; seed++) {
    const next = random(seed);
    const pick = () => filters[Math.floor(next() * filters.length)] ?? "all";
    const inputs: StartupInput[] = [];
    let current = "all";
    for (let step = 0; step < 12; step++) {
      const roll = next();
      if (roll < 0.35) {
        current = pick();
        inputs.push({ type: "filter", filter: current });
      } else if (roll < 0.55) inputs.push({ type: "read", filter: pick() });
      else if (roll < 0.65) inputs.push({ type: "held" });
      else if (roll < 0.75) inputs.push({ type: "connected" });
      else if (roll < 0.8) inputs.push({ type: "disconnected" });
      else if (roll < 0.85) inputs.push({ type: "welcome" });
      else if (roll < 0.9) inputs.push({ type: "deadline" });
      else inputs.push({ type: "read", filter: current });
    }
    // Then everything that lets it go: it subscribes once, for the filter current at the end.
    const { subscribes, state } = run([
      ...inputs,
      { type: "held" },
      { type: "connected" },
      { type: "deadline" },
      { type: "welcome" },
    ]);
    expect(subscribes, `seed ${seed}`).toHaveLength(1);
    expect(state.phase).toBe("subscribed");
    // Unless it went earlier, the one subscribe is for the last filter.
    const before = run(inputs);
    if (before.subscribes.length === 0) expect(subscribes[0], `seed ${seed}`).toBe(current);
  }
});
