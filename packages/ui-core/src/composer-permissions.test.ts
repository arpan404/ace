import { expect, test } from "vitest";
import type { PermissionCapabilities, ProviderKind } from "@ace/protocol";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import {
  composerPermissionDefault,
  composerPermissionOption,
  composerPermissionOptions,
} from "./composer-permissions.ts";

const capabilities = (provider: ProviderKind): PermissionCapabilities => ({
  modes: nativePermissionModes(provider).map((mode) => mode.id),
  permissionModes: nativePermissionModes(provider),
  nativeAutoReview: ["claude", "codex", "cursor"].includes(provider),
  toolGate: provider !== "cursor" && provider !== "pi",
});

test.each([
  ["claude", "default", "auto", "bypassPermissions"],
  [
    "codex",
    ":read-only",
    '{"permissions":":workspace","approvalsReviewer":"auto_review"}',
    ":danger-full-access",
  ],
  ["opencode", "ask", "composer:auto-review", "allow"],
] as const)(
  "%s presets retain exact native permission selectors",
  (provider, manual, review, full) => {
    const options = composerPermissionOptions(provider, capabilities(provider));
    expect(options.map((option) => option.label)).toEqual(["Manual", "Auto review", "Full access"]);
    expect(options.map((option) => option.id)).toEqual([manual, review, full]);
    expect(options[0]?.unavailable).toBeUndefined();
    expect(options[2]?.unavailable).toBeUndefined();
    if (provider === "opencode") {
      expect(options[1]?.unavailable).toContain("does not support native automatic review");
      expect(options[2]?.description).toContain("rules still apply");
    } else expect(options[1]?.unavailable).toBeUndefined();
  },
);

test("Cursor isolation never claims to pause for manual approvals", () => {
  const options = composerPermissionOptions("cursor", capabilities("cursor"));
  expect(options[0]).toMatchObject({
    id: "composer:ask",
    unavailable: "Cursor cannot pause for approvals.",
  });
  expect(options[1]).toMatchObject({
    id: '{"sandboxOptions":{"enabled":true},"autoReview":true}',
    unavailable: undefined,
  });
  expect(options[2]).toMatchObject({
    id: '{"sandboxOptions":{"enabled":false},"autoReview":false}',
    unavailable: undefined,
  });
  expect(
    composerPermissionOption(
      "cursor",
      '{"sandboxOptions":{"enabled":true},"autoReview":false}',
      capabilities("cursor"),
    ).label,
  ).toBe("Sandbox enabled");
});

test("unknown native modes and absent review capability never invent permission presets", () => {
  const unknown: PermissionCapabilities = {
    modes: ["custom"],
    permissionModes: [
      {
        id: "custom",
        label: "Full access Auto",
        description: "A custom native mode",
        risk: "high",
      },
    ],
    nativeAutoReview: true,
    toolGate: true,
  };
  expect(composerPermissionOptions("claude", unknown).every((option) => option.unavailable)).toBe(
    true,
  );
  expect(composerPermissionOption("claude", "custom", unknown)).toMatchObject({
    id: "custom",
    label: "Full access Auto",
  });
  const withoutReview = { ...capabilities("claude"), nativeAutoReview: false };
  expect(composerPermissionOptions("claude", withoutReview)[1]).toMatchObject({
    id: "composer:auto-review",
    unavailable: "Claude Code does not support native automatic review.",
  });
  expect(
    composerPermissionOptions("pi", capabilities("pi")).every((option) => option.unavailable),
  ).toBe(true);
});

test("automatic permission defaults are explicit advertised selectors and saved settings win", () => {
  expect(composerPermissionDefault("claude", null, capabilities("claude"))).toBe("auto");
  expect(composerPermissionDefault("codex", undefined, capabilities("codex"))).toBe(
    '{"permissions":":workspace","approvalsReviewer":"auto_review"}',
  );
  expect(composerPermissionDefault("cursor", null, capabilities("cursor"))).toBe(
    '{"sandboxOptions":{"enabled":true},"autoReview":true}',
  );
  expect(composerPermissionDefault("opencode", null, capabilities("opencode"))).toBe("ask");
  expect(composerPermissionDefault("claude", "acceptEdits", capabilities("claude"))).toBe(
    "acceptEdits",
  );
  expect(composerPermissionDefault("claude", "future-mode", capabilities("claude"))).toBe(
    "future-mode",
  );
  expect(
    composerPermissionDefault("claude", null, {
      ...capabilities("claude"),
      nativeAutoReview: false,
    }),
  ).toBe("default");
  expect(
    composerPermissionDefault("cursor", null, {
      ...capabilities("cursor"),
      nativeAutoReview: false,
    }),
  ).toBeNull();
  expect(composerPermissionDefault("pi", null, capabilities("pi"))).toBeNull();
});
