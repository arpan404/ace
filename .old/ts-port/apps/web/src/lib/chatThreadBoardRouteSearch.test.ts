import { ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  buildSingleThreadRouteSearch,
  buildThreadBoardRouteSearch,
} from "./chatThreadBoardRouteSearch";

describe("buildSingleThreadRouteSearch", () => {
  it("clears board, diff, and workspace search state for single-thread navigation", () => {
    expect(buildSingleThreadRouteSearch()).toEqual({
      active: undefined,
      connection: undefined,
      diff: undefined,
      diffFilePath: undefined,
      diffTurnId: undefined,
      mode: undefined,
      pane: undefined,
      split: undefined,
      threads: undefined,
    });
  });
});

describe("buildThreadBoardRouteSearch", () => {
  it("prefers split and pane identity over serialized thread membership for saved boards", () => {
    const threadA = ThreadId.makeUnsafe("thread-a");
    const threadB = ThreadId.makeUnsafe("thread-b");

    expect(
      buildThreadBoardRouteSearch(
        [{ connectionUrl: null, threadId: threadA }],
        { connectionUrl: null, threadId: threadB },
        {
          paneId: "pane-b",
          splitId: "split-123",
        },
      ),
    ).toEqual({
      active: undefined,
      connection: undefined,
      pane: "pane-b",
      split: "split-123",
      threads: undefined,
    });
  });
});
