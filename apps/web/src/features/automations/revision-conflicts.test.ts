import { expect, test } from "vitest";
import {
  isAlreadyExists,
  isMissingAutomation,
  isRevisionConflict,
  staleDeleteMessage,
  staleWriteMessage,
} from "./revision-conflicts.ts";

test("a stale CAS write names the reload before the retry", () => {
  expect(isRevisionConflict(new Error("Automation revision conflict"))).toBe(true);
  expect(isRevisionConflict(new Error("automation revision CONFLICT"))).toBe(true);
  expect(isRevisionConflict(new Error("disabled_or_missing"))).toBe(false);
  expect(staleWriteMessage(new Error("Automation revision conflict"))).toMatch(
    /changed elsewhere.*Reload/i,
  );
});

test("a rejected create-only and a missing automation each read truthfully", () => {
  expect(isAlreadyExists(new Error("Automation already exists"))).toBe(true);
  expect(staleWriteMessage(new Error("Automation already exists"))).toMatch(/recreated elsewhere/i);
  expect(isMissingAutomation(new Error("Automation is missing"))).toBe(true);
  expect(staleWriteMessage(new Error("Automation is missing"))).toMatch(/no longer exists/i);
});

test("a rejected delete keeps the row instead of inventing success", () => {
  expect(staleDeleteMessage(new Error("Automation revision conflict"))).toMatch(
    /changed elsewhere.*before deleting/i,
  );
});
