import { expect, test } from "vitest";
import { inboxBackoffMs, inboxPollMs, inboxSettledMs } from "./inbox-model.ts";

const list = { host: "github.com", items: [], pollSeconds: 90, unchanged: false };

test("the inbox polls at GitHub's interval, waits longer after a rate limit or lost connection, and longest after a refusal", () => {
  expect(inboxPollMs(list, undefined)).toBe(90_000);
  expect(inboxPollMs(undefined, undefined)).toBe(60_000);
  expect(inboxPollMs(list, "forge_rate_limit")).toBe(inboxBackoffMs);
  expect(inboxPollMs(list, "forge_offline")).toBe(inboxBackoffMs);
  expect(inboxBackoffMs).toBeGreaterThan(90_000);
  // A refusal is asked again rarely, so a fixed sign-in or remote shows up on its own.
  expect(inboxSettledMs).toBeGreaterThan(inboxBackoffMs);
  for (const code of [
    "forge_notifications_unavailable",
    "forge_forbidden",
    "forge_unsupported",
    "forge_no_remote",
    "git_not_a_repo",
    "workspace_not_found",
  ])
    expect(inboxPollMs(list, code)).toBe(inboxSettledMs);
  // Anything else passes on its own: keep GitHub's interval.
  expect(inboxPollMs(list, "forge_cli")).toBe(90_000);
});
