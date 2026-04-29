import { describe, expect, it } from "vitest";

import {
  evictExpiredRecentBrowserInstances,
  removeRecentBrowserInstance,
  resolveNextRecentBrowserInstanceExpiry,
  touchRecentBrowserInstance,
} from "./liveInstanceCache";

describe("touchRecentBrowserInstance", () => {
  it("adds a new instance at the front and caps the cache size", () => {
    expect(
      touchRecentBrowserInstance(
        [
          { instanceId: "thread-1", lastOpenedAt: 100 },
          { instanceId: "thread-2", lastOpenedAt: 200 },
        ],
        "thread-3",
        300,
        2,
      ),
    ).toEqual([
      { instanceId: "thread-3", lastOpenedAt: 300 },
      { instanceId: "thread-1", lastOpenedAt: 100 },
    ]);
  });

  it("moves an existing instance to the front and refreshes its timestamp", () => {
    expect(
      touchRecentBrowserInstance(
        [
          { instanceId: "thread-1", lastOpenedAt: 100 },
          { instanceId: "thread-2", lastOpenedAt: 200 },
        ],
        "thread-2",
        450,
        3,
      ),
    ).toEqual([
      { instanceId: "thread-2", lastOpenedAt: 450 },
      { instanceId: "thread-1", lastOpenedAt: 100 },
    ]);
  });

  it("returns an empty cache when the max entry count is zero", () => {
    expect(
      touchRecentBrowserInstance(
        [{ instanceId: "thread-1", lastOpenedAt: 100 }],
        "thread-2",
        200,
        0,
      ),
    ).toEqual([]);
  });
});

describe("removeRecentBrowserInstance", () => {
  it("removes the requested instance and keeps the remaining order stable", () => {
    expect(
      removeRecentBrowserInstance(
        [
          { instanceId: "thread-1", lastOpenedAt: 100 },
          { instanceId: "thread-2", lastOpenedAt: 200 },
          { instanceId: "thread-3", lastOpenedAt: 300 },
        ],
        "thread-2",
      ),
    ).toEqual([
      { instanceId: "thread-1", lastOpenedAt: 100 },
      { instanceId: "thread-3", lastOpenedAt: 300 },
    ]);
  });
});

describe("evictExpiredRecentBrowserInstances", () => {
  it("evicts entries that have exceeded the ttl", () => {
    expect(
      evictExpiredRecentBrowserInstances(
        [
          { instanceId: "thread-1", lastOpenedAt: 100 },
          { instanceId: "thread-2", lastOpenedAt: 200 },
          { instanceId: "thread-3", lastOpenedAt: 350 },
        ],
        600,
        300,
      ),
    ).toEqual([{ instanceId: "thread-3", lastOpenedAt: 350 }]);
  });

  it("keeps the protected active entry even when it is older than the ttl", () => {
    expect(
      evictExpiredRecentBrowserInstances(
        [
          { instanceId: "thread-1", lastOpenedAt: 100 },
          { instanceId: "thread-2", lastOpenedAt: 200 },
        ],
        600,
        300,
        "thread-1",
      ),
    ).toEqual([{ instanceId: "thread-1", lastOpenedAt: 100 }]);
  });
});

describe("resolveNextRecentBrowserInstanceExpiry", () => {
  it("returns the earliest expiry among unprotected entries", () => {
    expect(
      resolveNextRecentBrowserInstanceExpiry(
        [
          { instanceId: "thread-1", lastOpenedAt: 100 },
          { instanceId: "thread-2", lastOpenedAt: 250 },
          { instanceId: "thread-3", lastOpenedAt: 400 },
        ],
        300,
        "thread-3",
      ),
    ).toBe(400);
  });

  it("returns null when every entry is protected or ttl is disabled", () => {
    expect(
      resolveNextRecentBrowserInstanceExpiry(
        [{ instanceId: "thread-1", lastOpenedAt: 100 }],
        300,
        "thread-1",
      ),
    ).toBeNull();
    expect(
      resolveNextRecentBrowserInstanceExpiry([{ instanceId: "thread-1", lastOpenedAt: 100 }], 0),
    ).toBeNull();
  });
});
