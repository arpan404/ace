import { facts, replayCursor } from "@ace/fake-daemon";
import type { TodoEntry } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-replay-cursor";
const todo = (content: string, status: TodoEntry["status"]): TodoEntry => ({ content, status });
async function open() {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open(`/t/${threadId}`);
  const plan = (todos: TodoEntry[]) =>
    act(() =>
      app.daemon.apply(threadId, [
        facts.tool("root", "root-plan", {
          kind: "todo",
          title: "Update the plan",
          detail: { kind: "todo", todos },
        }),
      ]),
    );
  return { app, plan };
}
const live = () => screen.getByRole("button", { name: "Open work and agents" });

test("operational plans show the current step in the live line and their full list in Work, without a composer strip", async () => {
  const { plan } = await open();
  plan([
    todo("Find the reset", "completed"),
    todo("Fix it", "in_progress"),
    todo("Test", "pending"),
  ]);
  await waitFor(() => expect(live().textContent).toContain("Step 2 of 3 · Fix it"));
  expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  await userEvent.click(live());
  expect(await screen.findByRole("tab", { name: "Work" })).toBeTruthy();
  const list = await screen.findByRole("list", { name: "Plan" });
  expect(
    screen.queryByText(
      "The main agent is still working. The thread settles when it finishes its turn.",
    ),
  ).toBeNull();
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent),
  ).toEqual(["1.Find the resetDone", "2.Fix itIn progress", "3.TestTo do"]);
  expect(within(list).getAllByRole("listitem")[1]?.getAttribute("aria-current")).toBe("step");
});

test("operational plan updates advance the live step and completed plans leave after the turn ends", async () => {
  const { app, plan } = await open();
  plan([todo("Fix it", "in_progress"), todo("Test", "pending")]);
  await waitFor(() => expect(live().textContent).toContain("Step 1 of 2 · Fix it"));
  plan([todo("Fix it", "completed"), todo("Test", "in_progress")]);
  await waitFor(() => expect(live().textContent).toContain("Step 2 of 2 · Test"));
  await userEvent.click(live());
  plan([todo("Fix it", "completed"), todo("Test", "completed")]);
  act(() => app.daemon.apply(threadId, [facts.endTurn("root")]));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Plan" })).toBeNull());
});

test("human plan reviews keep their accept and reject controls on the attached strip", async () => {
  const { app, plan } = await open();
  plan([todo("Fix it", "in_progress")]);
  act(() =>
    app.daemon.apply(threadId, [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "review-plan",
        blocking: true,
        request: {
          kind: "plan_review",
          title: "Review the implementation plan",
          markdown: "1. Fix the cursor.\n2. Verify the reconnect.",
        },
      },
    ]),
  );
  const strip = await screen.findByRole("region", { name: "Waiting for you" });
  expect(within(strip).getByText("Review the implementation plan")).toBeTruthy();
  expect(within(strip).getByRole("button", { name: "Approve plan" })).toBeTruthy();
  expect(within(strip).getByRole("button", { name: "Request changes" })).toBeTruthy();
});
