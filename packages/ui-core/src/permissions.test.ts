import { expect, test } from "vitest";
import { permissionAdmission, permissionChoices, permissionFallback } from "./permissions.ts";
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
