import { expect, test } from "vitest";
import { firstLaunch } from "./first-launch.ts";
import { Organizer } from "./organizer.ts";
import type { KeyValueStorage } from "./storage.ts";

const hour = 3_600_000;
const now = 10 * 24 * hour;
const launch = now - 5 * hour;

function memory(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("Activity and Home's organizer judge unread against the same first launch", () => {
  const storage = memory();
  // Activity asks first, at launch; Home's organizer comes later and keeps that moment.
  expect(firstLaunch(storage, launch)).toBe(launch);
  expect(new Organizer(storage, now).getState().baseline).toBe(launch);
  expect(firstLaunch(storage, now)).toBe(launch);

  // And the other way round.
  const other = memory();
  expect(new Organizer(other, launch).getState().baseline).toBe(launch);
  expect(firstLaunch(other, now)).toBe(launch);
});
