import { queuedDelegation, queuedDelegationIds } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("a delegated child is titled in words and its first message is just the task", async () => {
  const app = harness();
  for (const scenario of queuedDelegation()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${queuedDelegationIds.running}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("Tidy settings.")).toBeTruthy();
  expect(feed.textContent).not.toMatch(/Role:|Task:/);
  expect(await screen.findByRole("heading", { level: 1, name: "Clean iOS settings" })).toBeTruthy();
});
