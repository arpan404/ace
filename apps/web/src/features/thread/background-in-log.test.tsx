import { watchingRelay } from "@ace/fake-daemon";
import { configure, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

test("commands left running in the background read as a step inside the turn's work log", async () => {
  const app = harness();
  const scenario = watchingRelay();
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const group = await within(feed).findByRole("group", { name: "2 background tasks · 1 running" });
  // A step of the log, among its other steps, not a row of its own under it.
  const steps = group.closest("ul[aria-label='Steps']");
  expect(steps).not.toBeNull();
  expect(group.closest("li")?.parentElement).toBe(steps);
  // The running command keeps its own line, Stop and all, in place.
  expect(
    within(group).getByRole("group", { name: "Background task bun run dev:relay" }).textContent,
  ).toContain("Running in background");
});
