import { uxAudit } from "./ux-audit.ts";
import { aceTools } from "./ace-tools.ts";
import type { ProviderKind } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { teamAtLimit } from "./account-limit.ts";
import { coldStartReplay } from "./cold-start-replay.ts";
import { delegatedDocs } from "./delegated-docs.ts";
import { failingSubagent } from "./failing-subagent.ts";
import { flakyCheckout } from "./flaky-checkout.ts";
import { homeList } from "./home-list.ts";
import { multiDayDemo } from "./multi-day-demo.ts";
import { longHistory } from "./long-history.ts";
import { permissionAudit } from "./permission-audit.ts";
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
 * threads the panels and tests are designed around. The fake boot plays it, and every screen
 * reads these threads over the wire, so screens agree.
 */
export function devWorld(): WorldThread[] {
  return withAccounts([
    ...uxAudit().map((scenario) => ({ scenario, agoMs: 10 * minute })),
    { scenario: longHistory(120), agoMs: 2 * 24 * 60 * minute },
    { scenario: multiDayDemo(), agoMs: 0 },
    ...homeList().map((aged) => ({ scenario: aged.scenario, agoMs: aged.agoMs })),
    { scenario: flakyCheckout(), agoMs: 3 * minute, live: { speed: 1 } },
    { scenario: replayCursor(), agoMs: 4 * minute, live: { speed: 1 } },
    // The thread the right and bottom panels are designed around: its turns already happened,
    // the subagents report back live.
    { scenario: coldStartReplay(), agoMs: 0, through: "relay-output", live: { speed: 1 } },
    { scenario: failingSubagent(), agoMs: 12 * minute, live: { speed: 0.5 } },
    // ace's risk policy approving, denying and escalating a release's commands.
    { scenario: permissionAudit(), agoMs: 6 * minute },
    // A thread that delegated work to Codex through ace: the delegate is a thread of its own.
    ...delegatedDocs().map((scenario) => ({ scenario, agoMs: 3 * 60 * minute })),
    // Agents using ace's own tools: computer use, the browser and a simulator.
    ...aceTools().map((scenario) => ({ scenario, agoMs: 20 * minute })),
    // The exhausted Codex Team account's threads, stopped at its limit (Usage & accounts).
    ...teamAtLimit().map((scenario) => ({ scenario, agoMs: 40 * minute })),
  ]);
}

/** The accounts of the design (catalog/accounts.ts) each provider's threads run on, in turn. */
const accountsByProvider: Partial<Record<ProviderKind, readonly string[]>> = {
  claude: ["claude-personal", "claude-work", "claude-personal"],
  codex: ["codex-personal"],
  acp: ["gemini-google"],
  opencode: ["opencode"],
  cursor: ["cursor"],
};

/**
 * Every thread runs on a signed-in account, as on a real daemon (`live.account`), so Usage &
 * accounts counts each account's running threads. Threads that name one keep it.
 */
function withAccounts(world: WorldThread[]): WorldThread[] {
  const turns = new Map<ProviderKind, number>();
  return world.map((entry) => {
    const { thread } = entry.scenario;
    const accounts = accountsByProvider[thread.provider];
    if (thread.live?.account || !accounts?.length) return entry;
    const turn = turns.get(thread.provider) ?? 0;
    turns.set(thread.provider, turn + 1);
    const account = accounts[turn % accounts.length];
    return {
      ...entry,
      scenario: { ...entry.scenario, thread: { ...thread, live: { ...thread.live, account } } },
    };
  });
}
