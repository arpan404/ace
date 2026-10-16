import { describe, expect, test } from "vitest";
import {
  batchDuplicateRoleProblem,
  duplicateRoleProblem,
  genericRoleBase,
  internalRole,
  normalizeRole,
  roleProblem,
} from "./role-names.ts";

describe("role names", () => {
  test("normalizes case and whitespace for comparisons", () => {
    expect(normalizeRole("  Implementer ")).toBe("implementer");
  });

  test("strips numbered retries to the generic base", () => {
    expect(genericRoleBase("Implementer 2")).toBe("implementer");
    expect(genericRoleBase("worker-2")).toBe("worker");
    expect(genericRoleBase("Fix-869-worked-for-toast")).toBe("fix-869-worked-for-toast");
  });

  test("rejects blank and generic roles with a descriptive example", () => {
    expect(roleProblem("   ")).toContain("Fix-869-worked-for-toast");
    expect(roleProblem("Implementer")).toContain("generic");
    expect(roleProblem("worker-2")).toContain("generic");
    expect(roleProblem("Fix-869-worked-for-toast")).toBeUndefined();
  });

  test("exempts internal roles agents never choose", () => {
    expect(internalRole("automation: nightly")).toBe(true);
    expect(internalRole("handoff: branch")).toBe(true);
    expect(roleProblem("configuration")).toBeUndefined();
  });

  test("duplicate messages name the fix", () => {
    expect(duplicateRoleProblem("Implementer")).toContain("already used");
    expect(batchDuplicateRoleProblem("Implementer")).toContain("twice");
  });
});
