import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { FakeDaemon } from "./daemon.ts";
import { ScenarioPlayer } from "./scenario.ts";
import { coldStartReplay } from "./scenarios/cold-start-replay.ts";
import { dedupeReconnect } from "./scenarios/dedupe-reconnect.ts";

const minute = 60_000;
const now = 1_000 * minute;

function itemsOf(daemon: FakeDaemon, threadId: string) {
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
  if (view?.kind !== "thread") throw new Error("expected the thread");
  return view;
}

test("a seeded thread reads as lived in: its ask was minutes ago, its tool work spans minutes", () => {
  const daemon = new FakeDaemon({ clock: () => now });
  new ScenarioPlayer(daemon, dedupeReconnect()).runUntilBlocked();
  const view = itemsOf(daemon, "thread-dedupe");
  const items = Object.values(view.items);
  const times = items.map((item) => item.createdAt);
  expect(now - Math.min(...times)).toBe(11 * minute);
  expect(now - Math.max(...times)).toBe(1.5 * minute);
  const reasoning = items.find((item) => item.type === "reasoning");
  // The run of tool work before the answer (6m 40s ago), not the later spawns and relay.
  const steps = items.flatMap((item) =>
    item.type === "tool_call" && item.call.startedAt < now - 6.5 * minute
      ? [item.call.startedAt]
      : [],
  );
  // "Worked for 4m 12s": from the first thought to the last step of that run of work.
  expect(Math.max(...steps) - (reasoning?.createdAt ?? 0)).toBe(4 * minute + 12_000);
});

test("a whole scenario can be played as if it happened earlier, never before the epoch", () => {
  const daemon = new FakeDaemon({ clock: () => 5 * minute });
  new ScenarioPlayer(daemon, dedupeReconnect(), { agoMs: 2 * minute }).runUntilBlocked();
  const times = Object.values(itemsOf(daemon, "thread-dedupe").items).map((item) => item.createdAt);
  expect(Math.max(...times)).toBe(5 * minute - 2 * minute - 1.5 * minute);
  // Steps further back than the clock goes are pinned to zero rather than negative.
  expect(Math.min(...times)).toBe(0);
});

test("a script's adapter key resolves to the daemon's item id, for seeding what a reader saw", () => {
  const daemon = new FakeDaemon({ clock: () => now });
  new ScenarioPlayer(daemon, dedupeReconnect()).runUntilBlocked();
  const relay = daemon.itemId("thread-dedupe", "relay");
  const item = relay ? itemsOf(daemon, "thread-dedupe").items[relay] : undefined;
  expect(item?.type === "tool_call" && item.call.title).toBe("Run the relay in the background");
  expect(daemon.itemId("thread-dedupe", "no-such-key")).toBeUndefined();
});

test("the panels thread's turns, subagents and background relay are minutes old when the page opens", () => {
  const daemon = new FakeDaemon({ clock: () => now });
  new ScenarioPlayer(daemon, coldStartReplay()).runThrough("relay-output");
  const view = itemsOf(daemon, "thread-cold-start");
  const runs = Object.values(view.runs).map((run) => now - run.startedAt);
  // Turn one 24 minutes ago, turn two 9; the subagents 7m 20s.
  expect(Math.max(...runs)).toBe(24 * minute);
  expect(runs.filter((ago) => ago === 9 * minute)).toHaveLength(1);
  expect(runs.filter((ago) => ago === 7 * minute + 20_000)).toHaveLength(2);
  const [relay] = Object.values(view.backgroundTasks);
  expect(now - (relay?.startedAt ?? now)).toBe(5 * minute + 20_000);
  // The first turn's work spans minutes between its steps, so it never reads "Worked for 1s".
  const turnOne = Object.values(view.items).flatMap((item) =>
    item.type === "tool_call" && now - item.call.startedAt > 20 * minute
      ? [item.call.startedAt]
      : [],
  );
  expect(Math.max(...turnOne) - Math.min(...turnOne)).toBeGreaterThan(minute);
});
