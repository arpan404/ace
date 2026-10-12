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

test("Snoozed remembers its disclosure across reloads and older storage defaults closed", () => {
  const storage = memory();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ baseline: launch, project: null, settledOpen: true }),
  );
  const organizer = new Organizer(storage, now);
  expect(organizer.getState().snoozedOpen).toBe(false);
  organizer.setSnoozedOpen(true);
  expect(new Organizer(storage, now).getState().snoozedOpen).toBe(true);
  organizer.setSnoozedOpen(false);
  expect(new Organizer(storage, now).getState().snoozedOpen).toBe(false);
});
