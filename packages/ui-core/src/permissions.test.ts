import type { PermissionCapabilities } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  permissionAdmission,
  permissionChoices,
  permissionCoverage,
  permissionCoverageNote,
  permissionModeOf,
  permissionOptions,
  permissionPendingNote,
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

test("the modes the provider supports are offered strictest first, and Ask only with a tool gate", () => {
  expect(permissionChoices({ ...codexLike, modes: [...codexLike.modes, "ask"] })).toEqual(
    expect.arrayContaining([expect.objectContaining({ mode: "ask", unavailable: undefined })]),
  );
  // Listing Ask is not enough: without a gate before each action, nobody can approve first.
  const cursorLike = { ...codexLike, modes: [...codexLike.modes, "ask" as const], toolGate: false };
  expect(
    permissionChoices(cursorLike, "Cursor").map((choice) => [choice.mode, choice.unavailable]),
  ).toEqual([
    ["read-only", undefined],
    ["ask", "Cursor can't pause for your approval"],
    ["auto-review", undefined],
    ["full-access", undefined],
  ]);
  expect(permissionChoices(undefined)).toEqual([]);
});

test("a new thread never starts in a mode its provider can't honour, and says what it uses", () => {
  const cursorLike = { ...codexLike, toolGate: false };
  expect(permissionAdmission(cursorLike, "ask", "Cursor")).toEqual({
    mode: "read-only",
    fallback: "Cursor can't pause for your approval, so the thread starts in Read only",
  });
  // With nothing stricter, the nearest looser mode short of full access.
  const acpLike: PermissionCapabilities = { ...cursorLike, modes: ["auto-review", "full-access"] };
  expect(permissionAdmission(acpLike, "ask", "Gemini")).toEqual({
    mode: "auto-review",
    fallback: "Gemini can't pause for your approval, so the thread starts in Auto-review",
  });
  expect(permissionAdmission(cursorLike, "full-access", "Cursor")).toEqual({
    mode: "full-access",
    fallback: undefined,
  });
  // Unknown capabilities are never a refusal.
  expect(permissionAdmission(undefined, "ask", "Cursor").mode).toBe("ask");
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

test("a chosen mode waiting for the next turn shows beside the one in effect until it applies", () => {
  const waiting = threadPermissionSummary(
    { override: "full-access", effective: "auto-review", pending: true },
    codexLike,
  );
  // The chip shows the mode the agent runs under now, and the one replacing it.
  expect(waiting).toMatchObject({ mode: "auto-review", next: "full-access", inherited: false });
  const applied = threadPermissionSummary(
    { override: "full-access", effective: "full-access", pending: false },
    codexLike,
  );
  expect(applied).toMatchObject({ mode: "full-access", next: undefined });
});

test("a change made here shows at once, before the daemon reports it", () => {
  const settled = { override: null, effective: "auto-review", pending: false } as const;
  expect(threadPermissionSummary(settled, codexLike, { chosen: "read-only" })).toMatchObject({
    mode: "auto-review",
    next: "read-only",
    inherited: false,
  });
  // Choosing the mode already in effect changes nothing to wait for.
  expect(threadPermissionSummary(settled, codexLike, { chosen: "auto-review" })?.next).toBe(
    undefined,
  );
});

test("going back to the default waits for the default's mode, when that differs", () => {
  const own = { override: "full-access", effective: "full-access", pending: false } as const;
  expect(
    threadPermissionSummary(own, codexLike, { chosen: null, defaultMode: "auto-review" }),
  ).toMatchObject({ mode: "full-access", next: "auto-review", inherited: true });
  expect(
    threadPermissionSummary(
      { override: null, effective: "full-access", pending: true },
      codexLike,
      { defaultMode: "full-access" },
    )?.next,
  ).toBe(undefined);
});

test("the default mode is named, not left to its icon", () => {
  const summary = threadPermissionSummary(
    { override: null, effective: "auto-review", pending: false },
    codexLike,
  );
  expect(summary).toMatchObject({ mode: "auto-review", inherited: true, label: "Auto-review" });
  expect(threadPermissionSummary(undefined, codexLike)).toBeUndefined();
});

test("a pending change says when it applies: the next turn, or the running command's end", () => {
  expect(permissionPendingNote()).toBe("Applies at the agent's next turn");
  expect(permissionPendingNote("busy")).toBe("Applies when the running command finishes");
});

test("coverage is said once: what the mode in effect gates, or that the provider doesn't say", () => {
  expect(permissionCoverageNote({ ...codexLike, guarantees: [] }, "Codex", "auto-review")).toBe(
    "Codex doesn't report what each mode gates",
  );
  expect(permissionCoverageNote(codexLike, "Codex", "auto-review")).toBe(
    "Auto-review: Protected reads not gated",
  );
});

test("the composer's generic list carries each supported mode with how much it risks", () => {
  const options = permissionOptions(codexLike, "Codex");
  expect(options.map((option) => [option.id, option.risk])).toEqual([
    ["read-only", "low"],
    ["ask", "low"],
    ["auto-review", "medium"],
    ["full-access", "high"],
  ]);
  // Ask stays listed, disabled with why, for a provider that can't pause for approval.
  expect(options.find((option) => option.id === "ask")?.unavailable).toBe(
    "Codex can't pause for your approval",
  );
  expect(options.find((option) => option.id === "full-access")).toMatchObject({
    label: "Full access",
    description: "Edits, runs and fetches without asking",
  });
  expect(permissionOptions(undefined)).toEqual([]);
});

test("an option id maps back to ace's mode, and an unknown one to none", () => {
  expect(permissionModeOf("full-access")).toBe("full-access");
  expect(permissionModeOf("bypassPermissions")).toBeUndefined();
});
