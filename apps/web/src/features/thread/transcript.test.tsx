import { longHistory } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

function questionNumbers(feed: HTMLElement): number[] {
  return within(feed)
    .getAllByText(/^Question \d+:/)
    .map((node) => Number(/Question (\d+)/.exec(node.textContent ?? "")?.[1]));
}

test("the transcript opens on the newest window and pages older history in order", async () => {
  const app = harness({ snapshotItems: 20 });
  app.play(longHistory(60)).runUntilBlocked();
  await app.open("/w/acme-web/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Answer 60: route 60 renders its own panel.");

  // The snapshot carries only the newest 20 items: questions 51-60.
  expect(questionNumbers(feed)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);

  await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  await within(feed).findByText("Question 26: what does route 26 render?");
  expect(questionNumbers(feed)).toEqual(Array.from({ length: 35 }, (_, i) => i + 26));

  await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  await within(feed).findByText("Question 1: what does route 1 render?");
  expect(questionNumbers(feed)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull(),
  );
  expect(screen.getByText("Beginning of thread")).toBeTruthy();
});
