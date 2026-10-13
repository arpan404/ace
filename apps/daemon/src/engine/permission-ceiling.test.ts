import { expect, test } from "vitest";
import {
  allowedChildModes,
  ceilingMode,
  inheritedPermissionMode,
  permissionWithinCeiling,
} from "./permission-ceiling.ts";

const opencode = { provider: "opencode" as const, instanceId: "opencode-cli-default" };
const claude = { provider: "claude" as const, instanceId: "claude-cli-default" };
const codex = { provider: "codex" as const, instanceId: "codex-cli-default" };

test("an OpenCode plan parent may delegate to a Claude child in Claude's plan mode", () => {
  expect(permissionWithinCeiling({ ...opencode, mode: "plan" }, { ...claude, mode: "plan" })).toBe(
    true,
  );
});

test("a child above its parent's capability is refused on any provider", () => {
  for (const mode of ["default", "dontAsk", "acceptEdits", "bypassPermissions"])
    expect(permissionWithinCeiling({ ...opencode, mode: "plan" }, { ...claude, mode })).toBe(false);
  expect(
    permissionWithinCeiling({ ...claude, mode: "default" }, { ...codex, mode: ":workspace" }),
  ).toBe(false);
});

test("a refused child learns exactly the modes its parent would accept", () => {
  expect(allowedChildModes({ ...opencode, mode: "plan" }, claude)).toEqual(["plan"]);
  expect(allowedChildModes({ ...opencode, mode: "build" }, claude)).toEqual([
    "plan",
    "default",
    "dontAsk",
    "acceptEdits",
  ]);
});

test("an inherited child takes the most capable mode its parent allows", () => {
  expect(inheritedPermissionMode({ ...opencode, mode: "plan" }, claude)).toBe("plan");
  expect(inheritedPermissionMode({ ...opencode, mode: "build" }, claude)).toBe("acceptEdits");
  expect(inheritedPermissionMode({ ...codex, mode: ":danger-full-access" }, claude)).toBe(
    "bypassPermissions",
  );
  expect(inheritedPermissionMode({ ...claude, mode: "acceptEdits" }, claude)).toBe("acceptEdits");
});

test("opaque or unreported policies are contained only by the identical policy", () => {
  expect(permissionWithinCeiling({ ...opencode, mode: null }, { ...claude, mode: "plan" })).toBe(
    false,
  );
  expect(permissionWithinCeiling({ ...codex, mode: "custom" }, { ...codex, mode: "custom" })).toBe(
    true,
  );
  expect(
    permissionWithinCeiling(
      { ...codex, mode: "custom" },
      { ...codex, instanceId: "work", mode: "custom" },
    ),
  ).toBe(false);
});

test("while a change is pending, children are measured against the stricter side", () => {
  expect(ceilingMode(opencode, null, "plan")).toBe("plan");
  expect(ceilingMode(opencode, "build", "plan")).toBe("plan");
  expect(ceilingMode(opencode, "plan", "build")).toBe("plan");
  expect(ceilingMode(opencode, "build", null)).toBe("build");
});
