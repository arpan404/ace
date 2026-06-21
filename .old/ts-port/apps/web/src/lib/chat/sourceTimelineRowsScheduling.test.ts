import { describe, expect, it } from "vitest";

import {
  shouldBuildSourceTimelineRowsOnMainThread,
  SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT,
} from "./sourceTimelineRowsScheduling";

describe("source timeline row scheduling", () => {
  it("builds small completed snapshots on the main thread", () => {
    expect(
      shouldBuildSourceTimelineRowsOnMainThread({
        hasCompleteSnapshot: true,
        rowCount: SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT,
      }),
    ).toBe(true);
  });

  it("uses the worker for large completed snapshots", () => {
    expect(
      shouldBuildSourceTimelineRowsOnMainThread({
        hasCompleteSnapshot: true,
        rowCount: SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT + 1,
      }),
    ).toBe(false);
  });

  it("does not delay partial live rows behind worker startup", () => {
    expect(
      shouldBuildSourceTimelineRowsOnMainThread({
        hasCompleteSnapshot: false,
        rowCount: SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT + 1,
      }),
    ).toBe(true);
  });

  it("does not build empty inputs", () => {
    expect(
      shouldBuildSourceTimelineRowsOnMainThread({
        hasCompleteSnapshot: false,
        rowCount: 0,
      }),
    ).toBe(false);
  });
});
