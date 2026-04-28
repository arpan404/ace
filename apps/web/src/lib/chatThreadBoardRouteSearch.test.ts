import { describe, expect, it } from "vitest";

import { buildSingleThreadRouteSearch } from "./chatThreadBoardRouteSearch";

describe("buildSingleThreadRouteSearch", () => {
  it("clears board, diff, and workspace search state for single-thread navigation", () => {
    expect(buildSingleThreadRouteSearch()).toEqual({
      active: undefined,
      connection: undefined,
      diff: undefined,
      diffFilePath: undefined,
      diffTurnId: undefined,
      mode: undefined,
      split: undefined,
      threads: undefined,
    });
  });
});
