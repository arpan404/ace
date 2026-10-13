import { expect, test } from "vitest";
import {
  permissionAdmission,
  permissionChoices,
  permissionFallback,
  threadPermissionSummary,
} from "./permissions.ts";
import { offeredOptions } from "./approvals.ts";
const capabilities = {
  modes: ["default", "acceptEdits"],
  nativeAutoReview: false,
  toolGate: true,
  permissionModes: [
    { id: "default", label: "Manual", description: "Native manual", risk: "medium" as const },
    {
      id: "acceptEdits",
      label: "Accept edits",
      description: "Native edits",
      risk: "medium" as const,
    },
  ],
};
test("pickers preserve native labels and reset a different provider's id to the native default", () => {
  expect(permissionChoices(capabilities).map((choice) => choice.label)).toEqual([
    "Manual",
    "Accept edits",
  ]);
  expect(permissionAdmission(capabilities, "deny", "Claude").mode).toBeUndefined();
  expect(permissionFallback(capabilities, "acceptEdits")).toBe("acceptEdits");
});
test("native permanent approval options remain available in every provider mode", () => {
  const options = [
    { id: "always", label: "Always allow", kind: "allow_always" as const },
    { id: "deny", label: "Deny", kind: "deny" as const },
  ];
  expect(offeredOptions(options, "default")).toEqual({ options, hidden: 0 });
});

test("returning to the provider default remains visible while the previous native mode is still effective", () => {
  const summary = threadPermissionSummary(
    { override: "acceptEdits", effective: "acceptEdits", pending: false },
    capabilities,
    { chosen: null },
  );
  expect(summary).toMatchObject({ mode: "acceptEdits", next: null, inherited: true });
});

test("verified full access names preserve the native selection, risk and provider-specific coverage", () => {
  const native = {
    ...capabilities,
    permissionModes: [
      {
        id: "yolo",
        label: "YOLO",
        description: "Native policy applies",
        risk: "high" as const,
        presentation: "full-access" as const,
      },
      {
        id: "review",
        label: "Guardian review",
        description: "Separate reviewer",
        risk: "medium" as const,
      },
    ],
  };
  const choices = permissionChoices(native);
  expect(choices).toEqual([
    {
      mode: "yolo",
      label: "Full access",
      description: "Native policy applies",
      coverage: "Native policy applies",
      attention: true,
    },
    {
      mode: "review",
      label: "Guardian review",
      description: "Separate reviewer",
      coverage: "Separate reviewer",
      attention: false,
    },
  ]);
  expect(permissionAdmission(native, choices[0]?.mode, "Gemini").mode).toBe("yolo");
  expect(
    threadPermissionSummary({ override: "yolo", effective: "yolo", pending: false }, native)?.label,
  ).toBe("Full access");
  expect(
    threadPermissionSummary({ override: "yolo", effective: "yolo", pending: false }, capabilities)
      ?.label,
  ).toBe("Other mode");
});
