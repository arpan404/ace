import { expect, test } from "vitest";
import {
  defaultPreparationTimeoutMs,
  resolvePreparationTimeoutMs,
} from "./creation-preparation.ts";

test("worktree preparation waits ten minutes unless told otherwise", () => {
  expect(defaultPreparationTimeoutMs).toBe(600_000);
  expect(resolvePreparationTimeoutMs()).toBe(600_000);
  expect(resolvePreparationTimeoutMs(undefined, {})).toBe(600_000);
});

test("an explicit per-environment timeout wins over the environment variable", () => {
  expect(
    resolvePreparationTimeoutMs(120_000, { ACE_WORKTREE_PREPARATION_TIMEOUT_MS: "300_000" }),
  ).toBe(120_000);
  expect(resolvePreparationTimeoutMs(120_000, {})).toBe(120_000);
});

test("the environment variable overrides the default when no explicit value is given", () => {
  expect(
    resolvePreparationTimeoutMs(undefined, { ACE_WORKTREE_PREPARATION_TIMEOUT_MS: "900000" }),
  ).toBe(900_000);
});

test("invalid values fall through to the default instead of stalling or failing fast", () => {
  expect(resolvePreparationTimeoutMs(0, {})).toBe(600_000);
  expect(resolvePreparationTimeoutMs(-5, {})).toBe(600_000);
  expect(resolvePreparationTimeoutMs(1.5, {})).toBe(600_000);
  expect(
    resolvePreparationTimeoutMs(undefined, { ACE_WORKTREE_PREPARATION_TIMEOUT_MS: "soon" }),
  ).toBe(600_000);
  expect(resolvePreparationTimeoutMs(undefined, { ACE_WORKTREE_PREPARATION_TIMEOUT_MS: "0" })).toBe(
    600_000,
  );
  expect(resolvePreparationTimeoutMs(NaN, { ACE_WORKTREE_PREPARATION_TIMEOUT_MS: "900000" })).toBe(
    900_000,
  );
});
