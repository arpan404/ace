import type { PermissionCapabilities } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  permissionChoices,
  permissionCoverage,
  permissionCoverageNote,
  threadPermissionSummary,
} from "./permissions.ts";

const codexLike: PermissionCapabilities = {
  modes: ["full-access", "auto-review", "read-only"],
  nativeAutoReview: false,
  toolGate: true,
  guarantees: [
    {
      mode: "auto-review",
      level: "sandbox",
      gates: { writes: true, network: true, protectedReads: false, shell: true },
      limitations: [],
    },
  ],
};

test("only the modes the provider supports are offered, strictest first", () => {
  expect(permissionChoices(codexLike).map((choice) => choice.mode)).toEqual([
    "read-only",
    "auto-review",
    "full-access",
  ]);
  expect(permissionChoices(undefined)).toEqual([]);
});

test("a provider that can't gate secret reads says so for auto-review", () => {
  expect(permissionCoverage(codexLike, "auto-review")).toBe("Protected reads not gated");
});

test("several open gates are listed together", () => {
  const acp: PermissionCapabilities = {
    ...codexLike,
    guarantees: [
      {
        mode: "auto-review",
        level: "permission-requests",
        gates: { writes: false, network: false, protectedReads: false, shell: true },
        limitations: [],
      },
    ],
  };
  expect(permissionCoverage(acp, "auto-review")).toBe(
    "Edits, network and protected reads not gated",
  );
});

test("a fully gated provider names what it gates", () => {
  const claude: PermissionCapabilities = {
    ...codexLike,
    guarantees: [
      {
        mode: "auto-review",
        level: "tool-gate",
        gates: { writes: true, network: true, protectedReads: true, shell: true },
        limitations: [],
      },
    ],
  };
  expect(permissionCoverage(claude, "auto-review")).toBe(
    "Gates edits, shell commands, network and protected reads",
  );
});

test("missing guarantee metadata reads as unknown, never as protected", () => {
  expect(permissionCoverage(codexLike, "read-only")).toBe("Coverage not reported by this provider");
  expect(permissionCoverage(undefined, "auto-review")).toBe(
    "Coverage not reported by this provider",
  );
});

test("full access is the mode that asks for attention and gates nothing", () => {
  const full = permissionChoices(codexLike).find((choice) => choice.mode === "full-access");
  expect(full).toMatchObject({ attention: true, coverage: "Nothing is gated" });
  expect(
    permissionChoices(codexLike)
      .filter((choice) => choice.attention)
      .map((c) => c.mode),
  ).toEqual(["full-access"]);
});

test("a chosen mode waiting for the turn to end shows as pending until it applies", () => {
  const waiting = threadPermissionSummary(
    { override: "read-only", effective: "auto-review", pending: true },
    codexLike,
  );
  expect(waiting).toMatchObject({ mode: "read-only", pending: true, inherited: false });
  const applied = threadPermissionSummary(
    { override: "read-only", effective: "read-only", pending: false },
    codexLike,
  );
  expect(applied).toMatchObject({ mode: "read-only", pending: false });
});

test("a thread without an override shows the inherited default", () => {
  expect(
    threadPermissionSummary(
      { override: null, effective: "auto-review", pending: false },
      codexLike,
    ),
  ).toMatchObject({ mode: "auto-review", inherited: true, label: "Auto-review" });
  expect(threadPermissionSummary(undefined, codexLike)).toBeUndefined();
});

test("coverage is said once: what the mode in effect gates, or that the provider doesn't say", () => {
  expect(permissionCoverageNote({ ...codexLike, guarantees: [] }, "Codex", "auto-review")).toBe(
    "Codex doesn't report what each mode gates",
  );
  expect(permissionCoverageNote(codexLike, "Codex", "auto-review")).toBe(
    "Auto-review: Protected reads not gated",
  );
});
