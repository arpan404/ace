import { describe, expect, it } from "vitest";

import { removeRecentBrowserInstanceId, touchRecentBrowserInstanceId } from "./liveInstanceCache";

describe("touchRecentBrowserInstanceId", () => {
  it("adds a new id at the front and caps the cache size", () => {
    expect(touchRecentBrowserInstanceId(["thread-1", "thread-2"], "thread-3", 2)).toEqual([
      "thread-3",
      "thread-1",
    ]);
  });

  it("moves an existing id to the front without duplicating it", () => {
    expect(touchRecentBrowserInstanceId(["thread-1", "thread-2"], "thread-2", 3)).toEqual([
      "thread-2",
      "thread-1",
    ]);
  });

  it("returns an empty cache when the max entry count is zero", () => {
    expect(touchRecentBrowserInstanceId(["thread-1"], "thread-2", 0)).toEqual([]);
  });
});

describe("removeRecentBrowserInstanceId", () => {
  it("removes the requested id and keeps the remaining order stable", () => {
    expect(removeRecentBrowserInstanceId(["thread-1", "thread-2", "thread-3"], "thread-2")).toEqual(
      ["thread-1", "thread-3"],
    );
  });
});
