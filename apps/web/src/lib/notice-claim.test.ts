import { expect, it } from "vitest";
import { claimNotice, type ClaimLocks, type ClaimStorage } from "./notice-claim.ts";

function memory(): ClaimStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
  };
}

/** One holder at a time per name, as the browser's Web Locks are. */
function locks(): ClaimLocks {
  const held = new Map<string, Promise<unknown>>();
  return {
    async request(name, callback) {
      const before = held.get(name) ?? Promise.resolve();
      const run = before.then(callback);
      held.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  };
}

it("of several tabs hearing one alert, one shows it, and a day later the mark is let go", async () => {
  const shared = memory();
  const lock = locks();
  const tabs = await Promise.all([1, 2, 3].map(() => claimNotice("spade:a", shared, lock, 1_000)));
  expect(tabs.filter(Boolean)).toHaveLength(1);
  expect(await claimNotice("spade:b", shared, lock, 2_000)).toBe(true);
  // A day on, a new claim clears the old marks.
  await claimNotice("spade:c", shared, lock, 1_000 + 86_400_001);
  expect(shared.getItem("ace.notice.shown:spade:a")).toBeNull();
});
