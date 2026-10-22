import { expect, test } from "vitest";
import { inboxBackoffMs, inboxPollMs } from "./inbox-model.ts";

const list = { host: "github.com", items: [], pollSeconds: 90, unchanged: false };

test("the inbox polls at GitHub's interval, waits longer after a rate limit or lost connection, and stops on a refusal", () => {
  expect(inboxPollMs(list, undefined)).toBe(90_000);
  expect(inboxPollMs(undefined, undefined)).toBe(60_000);
  expect(inboxPollMs(list, "forge_rate_limit")).toBe(inboxBackoffMs);
  expect(inboxPollMs(list, "forge_offline")).toBe(inboxBackoffMs);
  expect(inboxBackoffMs).toBeGreaterThan(90_000);
  expect(inboxPollMs(list, "forge_notifications_unavailable")).toBe(false);
  expect(inboxPollMs(list, "forge_forbidden")).toBe(false);
  expect(inboxPollMs(list, "forge_unsupported")).toBe(false);
  // Anything else passes on its own: keep GitHub's interval.
  expect(inboxPollMs(list, "forge_cli")).toBe(90_000);
});
