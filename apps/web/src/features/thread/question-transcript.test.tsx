import { uxAudit } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

await import("./items/work-log-steps.tsx");

async function openThread(id: string) {
  const scenario = uxAudit().find((entry) => entry.thread.id === id);
  if (!scenario) throw new Error(`ux audit lost ${id}`);
  const app = harness();
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${id}`);
  return { app, feed: await screen.findByRole("feed", { name: "Transcript" }) };
}

test("a waiting question stays in view as its own line, and the line brings its card up focused", async () => {
  const { feed } = await openThread("thread-ux-question-pick");
  const line = await within(feed).findByRole("button", {
    name: /is asking · Tabs or Spaces\?$/,
  });
  // Never folded into the steps the agent took before asking.
  expect(line.closest('[aria-label="Steps"]')).toBeNull();
  expect(within(feed).queryByRole("radio")).toBeNull();

  const region = await screen.findByRole("region", { name: "Waiting for you" });
  const card = await within(region).findByRole("article", { name: "Tabs or Spaces?" });
  screen.getByRole("combobox", { name: "Message" }).focus();
  await userEvent.click(line);
  await waitFor(() =>
    expect(document.activeElement).toBe(within(card).getByRole("radio", { name: /^Tabs/ })),
  );
});

test("an answered question folds into the turn's work log as the question beside its answer", async () => {
  const { feed } = await openThread("thread-ux-question-answered");
  expect(await within(feed).findByText(/The formatter is set up/)).toBeTruthy();
  // Folded with the turn's steps behind "Worked for", never a line of its own.
  expect(within(feed).queryByRole("group", { name: "Question: Tabs or Spaces?" })).toBeNull();
  expect(within(feed).queryByRole("button", { name: /is asking/ })).toBeNull();

  await userEvent.click(within(feed).getByRole("button", { name: /^Worked for/ }));
  const line = await within(feed).findByRole("group", { name: "Question: Tabs or Spaces?" });
  expect(line.textContent).toMatch(/asked · Tabs or Spaces\?.*Spaces$/);
  // It opens to every question and option, as before.
  await userEvent.click(within(line).getByRole("button", { name: "Show the question and answer" }));
  await userEvent.click(within(line).getByRole("button", { name: "Show all 2 options" }));
  expect(within(line).getByText(/Matches the existing files/)).toBeTruthy();
});
