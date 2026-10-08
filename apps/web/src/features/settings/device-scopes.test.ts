import { expect, test } from "vitest";
import { deviceScopeLabels } from "./device-scopes.ts";

test("access summaries show the highest recorded access and keep independent grants explicit", () => {
  expect(deviceScopeLabels(["read", "operate", "admin", "projects"])).toBe(
    "Administrator, Projects",
  );
  expect(deviceScopeLabels(["read", "operate"])).toBe("View and act");
  expect(deviceScopeLabels(["read", "desktop"])).toBe("View only, Desktop");
});

test("an independent grant does not invent permission to view the host", () => {
  expect(deviceScopeLabels(["projects"])).toBe("Projects");
  expect(deviceScopeLabels([])).toBe("No access");
});
