import { expect, test } from "vitest";
import { firstLaunch } from "./first-launch.ts";
import { Organizer } from "./organizer.ts";
import type { KeyValueStorage } from "./storage.ts";
import { entry } from "./test-entries.fixture.ts";
import { AttentionTally, entryAttention } from "./thread-state.ts";

const hour = 3_600_000;
const now = 10 * 24 * hour;
const launch = now - 5 * hour;

function memory(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("a thread adds needs you, or news finished after the first launch, or nothing", () => {
  const asks = entry("asks", { state: "needs_you", interactions: 1 }, now - hour);
  expect(entryAttention(asks, launch)).toBe("needs-you");
  // Never opened, finished after this device's first launch: news, as Home shows it.
  expect(entryAttention(entry("fresh", { state: "done" }, now - hour), launch)).toBe("unread");
  expect(entryAttention(entry("old", { state: "done" }, launch - hour), launch)).toBeUndefined();
  const read = { readAt: now - 2 * hour };
  expect(entryAttention(entry("seen", { state: "done" }, now - 3 * hour, read), launch)).toBe(
    undefined,
  );
  expect(
    entryAttention(entry("settled", { state: "done" }, now - hour, { settledAt: now }), launch),
  ).toBeUndefined();
  expect(
    entryAttention(
      entry("later", { state: "done" }, now - hour, { snoozedUntil: now + hour }),
      launch,
    ),
  ).toBeUndefined();
  expect(entryAttention(undefined, launch)).toBeUndefined();
});

test("the tally says needs you while any thread does, then news, and forgets threads that go", () => {
  const tally = new AttentionTally();
  tally.set("a", "unread");
  tally.set("b", "needs-you");
  expect(tally.value).toBe("needs-you");
  tally.set("b", "needs-you");
  tally.set("b", undefined);
  expect(tally.value).toBe("unread");
  tally.set("a", "needs-you");
  expect(tally.value).toBe("needs-you");
  tally.set("a", undefined);
  expect(tally.value).toBeUndefined();
  tally.set("c", "unread");
  tally.clear();
  expect(tally.value).toBeUndefined();
});

test("the rail and Home's organizer judge unread against the same first launch", () => {
  const storage = memory();
  // The rail asks first, at launch; Home's organizer comes later and keeps that moment.
  expect(firstLaunch(storage, launch)).toBe(launch);
  expect(new Organizer(storage, now).getState().baseline).toBe(launch);
  expect(firstLaunch(storage, now)).toBe(launch);

  // And the other way round.
  const other = memory();
  expect(new Organizer(other, launch).getState().baseline).toBe(launch);
  expect(firstLaunch(other, now)).toBe(launch);
});
