import { expect, test } from "vitest";
import { accessModeOffers } from "@ace/provider-kit/access-modes";
import {
  allowedChildModes,
  ceilingMode,
  inheritedPermissionMode,
  permissionWithinCeiling,
} from "./permission-ceiling.ts";

const opencode = { provider: "opencode" as const, instanceId: "opencode-cli-default" };
const claude = { provider: "claude" as const, instanceId: "claude-cli-default" };
const cursor = { provider: "cursor" as const, instanceId: "cursor-sdk-default" };
const acp = {
  provider: "acp" as const,
  acpAgentId: "local:one",
  installationId: "approved-one",
  instanceId: "one:default",
};

test("a child at or below its parent's mode is contained on any provider", () => {
  expect(
    permissionWithinCeiling({ ...opencode, mode: "ask" }, { ...claude, mode: "read-only" }),
  ).toBe(true);
  expect(permissionWithinCeiling({ ...opencode, mode: "ask" }, { ...claude, mode: "ask" })).toBe(
    true,
  );
  for (const mode of ["auto-review", "full-access"])
    expect(permissionWithinCeiling({ ...opencode, mode: "ask" }, { ...claude, mode })).toBe(false);
});

test("a refused child learns the modes its target supports under the parent", () => {
  expect(allowedChildModes({ ...claude, mode: "auto-review" }, accessModeOffers(opencode))).toEqual(
    ["read-only", "ask"],
  );
  // Cursor supports nothing as strict as Ask.
  expect(allowedChildModes({ ...claude, mode: "ask" }, accessModeOffers(cursor))).toEqual([]);
});

test("an inherited mode steps down to the nearest stricter mode the target supports", () => {
  expect(
    inheritedPermissionMode(
      { ...claude, mode: "auto-review" },
      opencode,
      accessModeOffers(opencode),
    ),
  ).toBe("ask");
  expect(
    inheritedPermissionMode({ ...claude, mode: "full-access" }, cursor, accessModeOffers(cursor)),
  ).toBe("full-access");
  expect(
    inheritedPermissionMode({ ...claude, mode: "ask" }, cursor, accessModeOffers(cursor)),
  ).toBeUndefined();
});

test("an unranked parent (agent default or Custom) contains only its identical policy", () => {
  expect(permissionWithinCeiling({ ...acp, mode: null }, { ...acp, mode: null })).toBe(true);
  expect(
    permissionWithinCeiling({ ...acp, mode: null }, { ...acp, instanceId: "other", mode: null }),
  ).toBe(false);
  expect(permissionWithinCeiling({ ...acp, mode: null }, { ...claude, mode: "read-only" })).toBe(
    false,
  );
  expect(
    permissionWithinCeiling(
      { ...claude, mode: "custom:dontAsk" },
      { ...claude, mode: "custom:dontAsk" },
    ),
  ).toBe(true);
  expect(inheritedPermissionMode({ ...acp, mode: null }, acp, [])).toBeNull();
});

test("a pending change is measured by the stricter of the running and requested modes", () => {
  expect(ceilingMode("full-access", "read-only")).toBe("read-only");
  expect(ceilingMode("read-only", "full-access")).toBe("read-only");
  expect(ceilingMode(null, "ask")).toBe("ask");
  expect(ceilingMode("ask", null)).toBe("ask");
});
