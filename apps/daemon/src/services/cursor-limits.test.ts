import { expect, test } from "vitest";
import { CursorLimitsSchema as Limits } from "@ace/adapter-cursor";
import {
  DEFAULT_CHECKPOINT_MB,
  MAX_CHECKPOINT_MB,
  cursorCheckpointLimitOverride,
} from "./cursor-limits.ts";

test("no setting means no override, so daemon options then the schema default apply", () => {
  expect(cursorCheckpointLimitOverride(undefined)).toEqual({});
  expect(cursorCheckpointLimitOverride({})).toEqual({});
  expect(cursorCheckpointLimitOverride({ maxCheckpointMb: undefined })).toEqual({});
  expect(Limits.parse({}).maxCheckpointBytes).toBe(DEFAULT_CHECKPOINT_MB * 1048576);
});

test("a set value converts MiB to per-session maxCheckpointBytes", () => {
  expect(cursorCheckpointLimitOverride({ maxCheckpointMb: 64 })).toEqual({
    maxCheckpointBytes: 64 * 1048576,
  });
  // The merged result must satisfy the adapter's strict Limits schema.
  expect(Limits.parse(cursorCheckpointLimitOverride({ maxCheckpointMb: 1 }))).toMatchObject({
    maxCheckpointBytes: 1048576,
  });
});

test("out-of-range values clamp to the 1-256 MiB budget", () => {
  expect(cursorCheckpointLimitOverride({ maxCheckpointMb: 1000 })).toEqual({
    maxCheckpointBytes: MAX_CHECKPOINT_MB * 1048576,
  });
  expect(cursorCheckpointLimitOverride({ maxCheckpointMb: -4 })).toEqual({
    maxCheckpointBytes: 1048576,
  });
});
