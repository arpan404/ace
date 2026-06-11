import { describe, expect, it } from "vitest";

import {
  shouldBuildNativeTimelineRowsOnMainThread,
  SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT,
} from "./nativeTimelineRowsScheduling";

describe("native timeline row scheduling", () => {
  it("builds small completed snapshots on the main thread", () => {
    expect(
      shouldBuildNativeTimelineRowsOnMainThread({
        hasCompleteSnapshot: true,
        rowCount: SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT,
      }),
    ).toBe(true);
  });

  it("uses the worker for large completed snapshots", () => {
    expect(
      shouldBuildNativeTimelineRowsOnMainThread({
        hasCompleteSnapshot: true,
        rowCount: SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT + 1,
      }),
    ).toBe(false);
  });

  it("does not delay partial live rows behind worker startup", () => {
    expect(
      shouldBuildNativeTimelineRowsOnMainThread({
        hasCompleteSnapshot: false,
        rowCount: SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT + 1,
      }),
    ).toBe(true);
  });

  it("does not build empty inputs", () => {
    expect(
      shouldBuildNativeTimelineRowsOnMainThread({
        hasCompleteSnapshot: false,
        rowCount: 0,
      }),
    ).toBe(false);
  });
});
