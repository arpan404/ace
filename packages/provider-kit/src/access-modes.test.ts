import { expect, test } from "vitest";
import type { AccessMode } from "@ace/protocol";
import {
  accessModeOffers,
  accessModeOrder,
  accessRank,
  instanceAccessModes,
  stricterOffer,
  storedAccess,
} from "./access-modes.ts";
import { acpPermissionModes } from "./permission-modes.ts";

const modes = (offers: { mode: AccessMode }[]) => offers.map((offer) => offer.mode);

test("each provider offers only the modes it supports natively", () => {
  expect(modes(accessModeOffers({ provider: "claude" }))).toEqual(accessModeOrder);
  expect(modes(accessModeOffers({ provider: "codex" }))).toEqual(accessModeOrder);
  // No native reviewer: no Auto review.
  expect(modes(accessModeOffers({ provider: "opencode" }))).toEqual([
    "read-only",
    "ask",
    "full-access",
  ]);
  // No human-approval path, and the sandbox still writes the workspace.
  expect(modes(accessModeOffers({ provider: "cursor" }))).toEqual(["auto-review", "full-access"]);
  expect(modes(accessModeOffers({ provider: "pi" }))).toEqual(["read-only", "full-access"]);
  expect(modes(accessModeOffers({ provider: "acp" }))).toEqual([]);
});

test("Codex offers a mode only when the CLI allows the profile it runs on", () => {
  expect(modes(instanceAccessModes({ provider: "codex" }, [":read-only", ":workspace"]))).toEqual([
    "read-only",
    "ask",
    "auto-review",
  ]);
  expect(modes(instanceAccessModes({ provider: "codex" }, [":read-only"]))).toEqual([
    "read-only",
    "ask",
  ]);
});

test("a verified ACP profile offers the modes its agent advertises; an unknown agent offers none", () => {
  const raw = {
    modes: {
      availableModes: [
        { id: "plan", name: "Plan" },
        { id: "default", name: "Default" },
        { id: "auto_edit", name: "Auto edit" },
        { id: "yolo", name: "YOLO" },
      ],
    },
  };
  const advertised = acpPermissionModes(raw, { profile: "gemini-043" }).map((mode) => mode.id);
  const gemini = instanceAccessModes({ provider: "acp", profile: "gemini-043" }, advertised);
  // auto_edit has no reviewer behind it, so Gemini has no Auto review.
  expect(gemini).toEqual([
    { mode: "read-only", native: "plan" },
    { mode: "ask", native: "default" },
    { mode: "full-access", native: "yolo" },
  ]);
  expect(instanceAccessModes({ provider: "acp" }, advertised)).toEqual([]);
});

test("a mode a provider lacks resolves to the nearest stricter one, never looser", () => {
  for (const provider of ["claude", "codex", "opencode", "cursor", "pi"] as const) {
    const offers = accessModeOffers({ provider });
    for (const requested of accessModeOrder) {
      const offer = stricterOffer(requested, offers);
      if (offer) expect(accessRank(offer.mode)).toBeLessThanOrEqual(accessRank(requested));
    }
  }
  expect(stricterOffer("auto-review", accessModeOffers({ provider: "opencode" }))?.mode).toBe(
    "ask",
  );
  expect(stricterOffer("ask", accessModeOffers({ provider: "pi" }))?.mode).toBe("read-only");
  // Nothing as strict as Ask on Cursor: no mode, rather than a looser one.
  expect(stricterOffer("ask", accessModeOffers({ provider: "cursor" }))).toBeUndefined();
});

test.each([
  ["claude", "plan", "read-only"],
  ["claude", "default", "ask"],
  ["claude", "dontAsk", "ask"],
  ["claude", "acceptEdits", "auto-review"],
  ["claude", "auto", "auto-review"],
  ["claude", "bypassPermissions", "full-access"],
  ["codex", ":read-only", "read-only"],
  ["codex", ":workspace", "auto-review"],
  ["codex", '{"permissions":":workspace","approvalsReviewer":"guardian_subagent"}', "auto-review"],
  ["codex", ":danger-full-access", "full-access"],
  ["codex", "my-team-profile", "ask"],
  ["opencode", "plan", "read-only"],
  ["opencode", "build", "auto-review"],
  ["cursor", '{"sandboxOptions":{"enabled":true},"autoReview":false}', "auto-review"],
  ["cursor", '{"sandboxOptions":{"enabled":false},"autoReview":true}', "auto-review"],
  ["cursor", '{"sandboxOptions":{"enabled":false},"autoReview":false}', "full-access"],
  ["acp", "auto_edit", "auto-review"],
  ["acp", "yolo", "full-access"],
  ["acp", "an-unknown-mode", undefined],
] as const)("a stored %s mode %s maps to %s", (provider, stored, expected) => {
  expect(storedAccess(provider, stored)).toBe(expected);
});
