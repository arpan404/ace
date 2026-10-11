import { expect, test } from "vitest";
import { acpPermissionModes, nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { permissionLabel } from "./permissions.ts";

const raw = {
  modes: {
    availableModes: [
      { id: "default", name: "Default", description: "Asks before tools" },
      {
        id: "yolo",
        name: "YOLO",
        description: "Auto-approves tools; configured sandbox still applies",
      },
    ],
  },
};

test("a verified Gemini selector presents full access while sending its advertised yolo id", () => {
  const modes = acpPermissionModes(raw, { profile: "gemini-043" });
  expect(modes[1]).toMatchObject({
    id: "yolo",
    label: "YOLO",
    description: raw.modes.availableModes[1]?.description,
  });
  expect(
    permissionLabel("yolo", {
      modes: modes.map((mode) => mode.id),
      permissionModes: modes,
      nativeAutoReview: false,
      toolGate: true,
    }),
  ).toBe("Full access");
});

test("an unknown agent's yolo name does not imply full access and native review modes remain distinct", () => {
  const modes = acpPermissionModes(raw);
  expect(
    permissionLabel("yolo", {
      modes: modes.map((mode) => mode.id),
      permissionModes: modes,
      nativeAutoReview: false,
      toolGate: true,
    }),
  ).toBe("YOLO");
  const codex = nativePermissionModes("codex");
  expect(
    codex.filter((mode) => mode.presentation === "full-access").map((mode) => mode.id),
  ).toEqual([":danger-full-access"]);
  expect(nativePermissionModes("cursor").some((mode) => mode.presentation)).toBe(false);
});
