import type { Scenario } from "../scenario.ts";
import { coldStartReplay } from "./cold-start-replay.ts";
import { failingSubagent } from "./failing-subagent.ts";
import { flakyCheckout } from "./flaky-checkout.ts";
import { homeList } from "./home-list.ts";
import { longHistory } from "./long-history.ts";
import { replayCursor } from "./replay-cursor.ts";

/** One thread of the development world and how it is played. */
export interface WorldThread {
  scenario: Scenario;
  /** The whole scenario is stamped this long before the daemon's now. */
  agoMs: number;
  /** Seeded through this label before the page opens; without it, until it blocks or ends. */
  through?: string;
  /** Keeps playing in real time once the page is open (at this speed), from where it was seeded. */
  live?: { speed: number };
}

const minute = 60_000;

/**
 * Every thread `dev:fake` shows: the Home list from the design, two days of history, and the live
 * threads the panels and tests are designed around. The fake boot plays it; catalogs that stand
 * in for missing protocol (changed files) derive from the same threads, so screens agree.
 */
export function devWorld(): WorldThread[] {
  return [
    { scenario: longHistory(120), agoMs: 2 * 24 * 60 * minute },
    ...homeList().map((aged) => ({ scenario: aged.scenario, agoMs: aged.agoMs })),
    { scenario: flakyCheckout(), agoMs: 3 * minute, live: { speed: 1 } },
    { scenario: replayCursor(), agoMs: 4 * minute, live: { speed: 1 } },
    // The thread the right and bottom panels are designed around: its turns already happened,
    // the subagents report back live.
    { scenario: coldStartReplay(), agoMs: 0, through: "relay-output", live: { speed: 1 } },
    { scenario: failingSubagent(), agoMs: 12 * minute, live: { speed: 0.5 } },
  ];
}
