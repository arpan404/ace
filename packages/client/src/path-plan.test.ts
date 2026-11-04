import { describe, expect, test } from "vitest";
import {
  afterFailure,
  afterSuccess,
  freshHealth,
  pingEvery,
  raceOrder,
  raceSchedule,
  restAfter,
  smoothRtt,
  standbyFor,
  switchVerdict,
  upgradeCandidates,
  type PathHealth,
  type PlannedPath,
} from "./path-plan.ts";

const loopback: PlannedPath = { key: "loopback", kind: "loopback" };
const lan: PlannedPath = { key: "lan", kind: "lan" };
const tailscale: PlannedPath = { key: "tailscale", kind: "tailscale" };
const relay: PlannedPath = { key: "relay", kind: "relay" };
const account: PlannedPath = { key: "account", kind: "account" };
const all = [account, relay, tailscale, lan, loopback];
const keys = (paths: readonly PlannedPath[]) => paths.map((path) => path.key);
const health = (entries: [string, PathHealth][] = []) => new Map(entries);

describe("a race", () => {
  test.each([
    [
      "best rank first",
      all,
      health(),
      undefined,
      ["loopback", "lan", "tailscale", "relay", "account"],
    ],
    [
      "the last winner first",
      all,
      health(),
      "relay",
      ["relay", "loopback", "lan", "tailscale", "account"],
    ],
    [
      "a resting path waits",
      [lan, relay],
      health([["lan", { failures: 1, restUntil: 2_000 }]]),
      undefined,
      ["relay"],
    ],
    [
      "a resting last winner waits too",
      [lan, relay],
      health([["relay", { failures: 1, restUntil: 2_000 }]]),
      "relay",
      ["lan"],
    ],
    [
      "when every path rests, the one rested soonest goes alone",
      [lan, relay],
      health([
        ["lan", { failures: 3, restUntil: 5_000 }],
        ["relay", { failures: 1, restUntil: 1_500 }],
      ]),
      undefined,
      ["relay"],
    ],
  ])("tries %s", (_name, paths, known, winner, expected) => {
    expect(keys(raceOrder(paths, known, 1_000, winner))).toEqual(expected);
  });

  test("starts each next path 150 ms after the previous one", () => {
    expect(raceSchedule([lan, tailscale, relay]).map((entry) => entry.at)).toEqual([0, 150, 300]);
  });
});

describe("a failed path", () => {
  test.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [6, 32_000],
    [7, 60_000],
    [20, 60_000],
  ])("rests after failure %i for %i ms", (failures, ms) => {
    expect(restAfter(failures)).toBe(ms);
  });

  test("rests longer each time it fails and starts over once it works", () => {
    let state = freshHealth;
    state = afterFailure(state, 0);
    expect(state.restUntil).toBe(1_000);
    state = afterFailure(state, 1_000);
    expect(state.restUntil).toBe(3_000);
    state = afterSuccess(state);
    state = afterFailure(state, 10_000);
    expect(state.restUntil).toBe(11_000);
  });
});

const verdict = (
  from: PlannedPath,
  fromRtt: number | undefined,
  to: PlannedPath,
  toRtt: number | undefined,
  switchedAt?: number,
) =>
  switchVerdict({
    active: { ...from, rttMs: fromRtt },
    candidate: { ...to, rttMs: toRtt },
    now: 100_000,
    switchedAt,
  });

describe("switching to a probed path", () => {
  test.each([
    ["20% and 5 ms faster switches", relay, 50, lan, 40, undefined, "switch"],
    ["5 ms faster but under 20% holds", relay, 100, lan, 95, undefined, "not_faster"],
    ["20% faster but under 5 ms holds", lan, 10, tailscale, 6, undefined, "not_faster"],
    ["slower never switches", tailscale, 20, lan, 30, undefined, "not_faster"],
    ["an unmeasured path waits", relay, undefined, lan, 10, undefined, "unmeasured"],
    ["the same computer always wins", lan, 1, loopback, 3, undefined, "switch"],
    ["a switch 9 s ago holds", relay, 80, lan, 5, 91_000, "hold"],
    ["a switch 10 s ago may switch again", relay, 80, lan, 5, 90_000, "switch"],
    ["the same computer also waits out the hold", lan, 5, loopback, 1, 95_000, "hold"],
  ] as const)("%s", (_name, from, fromRtt, to, toRtt, switchedAt, expected) => {
    expect(verdict(from, fromRtt, to, toRtt, switchedAt)).toBe(expected);
  });
});

describe("upgrade checks", () => {
  test("probe only better-ranked paths that are not resting, best first", () => {
    const known = health([["lan", { failures: 1, restUntil: 5_000 }]]);
    expect(keys(upgradeCandidates(all, account, known, 1_000))).toEqual([
      "loopback",
      "tailscale",
      "relay",
    ]);
  });
  test("probe nothing from the same computer", () => {
    expect(upgradeCandidates(all, loopback, health(), 0)).toEqual([]);
  });
});

describe("the warm standby", () => {
  test.each([
    ["the LAN keeps the person's relay ready", lan, all, "relay"],
    [
      "Tailscale keeps ace's relay when it is the only relay",
      tailscale,
      [tailscale, account],
      "account",
    ],
    ["the same computer keeps none", loopback, all, undefined],
    ["a relay keeps none", relay, all, undefined],
    ["a direct path with no relay keeps none", lan, [lan, tailscale], undefined],
  ] as const)("%s", (_name, active, paths, expected) => {
    expect(standbyFor(paths, active)?.key).toBe(expected);
  });
});

test("the smoothed round trip moves an eighth of the way to each sample", () => {
  expect(smoothRtt(undefined, 40)).toBe(40);
  expect(smoothRtt(40, 120)).toBe(50);
  expect(smoothRtt(50, -5)).toBeCloseTo(43.75);
});

test("pings every 5 s while visible and 15 s while hidden", () => {
  expect([pingEvery(true), pingEvery(false)]).toEqual([5_000, 15_000]);
});
