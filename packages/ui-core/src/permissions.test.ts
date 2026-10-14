import { expect, test } from "vitest";
import { accessModeOffers } from "@ace/provider-kit/access-modes";
import { accessChoices, supportedAccess, threadAccessSummary } from "./permissions.ts";

const offers = (provider: "claude" | "opencode" | "cursor") => accessModeOffers({ provider });

test("the access menu shows ace's four modes, without the ones a provider can't express", () => {
  expect(accessChoices(offers("claude")).map((choice) => choice.label)).toEqual([
    "Read-only",
    "Ask",
    "Auto review",
    "Full access",
  ]);
  expect(accessChoices(offers("opencode")).map((choice) => choice.label)).toEqual([
    "Read-only",
    "Ask",
    "Full access",
  ]);
  expect(accessChoices(offers("cursor")).map((choice) => choice.label)).toEqual([
    "Auto review",
    "Full access",
  ]);
  expect(accessChoices(offers("claude")).filter((choice) => choice.attention)).toEqual([
    expect.objectContaining({ mode: "full-access" }),
  ]);
});

test("a default a provider lacks runs as its nearest stricter mode and the chip says why", () => {
  expect(supportedAccess("auto-review", offers("opencode"))).toBe("ask");
  expect(supportedAccess("ask", offers("cursor"))).toBeUndefined();
  const summary = threadAccessSummary(
    { override: null, effective: "ask", pending: false },
    offers("opencode"),
    { defaultMode: "auto-review", provider: "OpenCode" },
  );
  expect(summary).toMatchObject({
    mode: "ask",
    label: "Ask",
    inherited: true,
    stricter: "Auto review isn't available for OpenCode",
  });
});

test("a chosen mode shows as pending until the provider runs it", () => {
  const summary = threadAccessSummary(
    { override: "ask", effective: "ask", pending: false },
    offers("claude"),
    { chosen: "full-access" },
  );
  expect(summary).toMatchObject({ mode: "ask", next: "full-access", inherited: false });
});

test("an Advanced native override reads as Custom", () => {
  expect(
    threadAccessSummary(
      { override: null, effective: null, custom: "my-profile", pending: false },
      offers("claude"),
      { defaultMode: "auto-review" },
    ),
  ).toMatchObject({ label: "Custom", custom: "my-profile", mode: null, stricter: undefined });
});
