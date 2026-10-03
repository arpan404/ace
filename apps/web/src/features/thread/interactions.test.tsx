import { flakyCheckout, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("an approval is answered in the thread and the agent carries on", async () => {
  const app = harness();
  const script = app.play(flakyCheckout());
  script.runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  const card = await screen.findByRole("article", {
    name: "Run rm -rf node_modules/.cache/vitest?",
  });
  expect(within(card).getByText("rm -rf node_modules/.cache/vitest")).toBeTruthy();
  expect(within(card).getByText(/Clears cached test results/)).toBeTruthy();
  // The step that asked is open in the work log, marked as waiting.
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(
    within(feed).getByRole("button", {
      name: "Run rm -rf node_modules/.cache/vitest Awaiting approval",
    }),
  ).toBeTruthy();

  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("article", { name: "Run rm -rf node_modules/.cache/vitest?" }),
    ).toBeNull(),
  );
  expect(app.daemon.resolution("thread-checkout", "approve-clear-cache")).toEqual({
    kind: "approval",
    optionId: "allow",
  });
  expect(script.blocked).toBe(false);
});

test("a question is answered with the chosen option", async () => {
  const app = harness();
  const question = workbench().find((scenario) => scenario.thread.id === "thread-sheet-rotate");
  if (!question) throw new Error("workbench lost the question thread");
  app.play(question).runUntilBlocked();
  await app.open("/t/thread-sheet-rotate");
  const card = await screen.findByRole("article", {
    name: "How should the sheet recover after rotate?",
  });
  const answer = within(card).getByRole("button", { name: "Answer" });
  expect(answer.hasAttribute("disabled")).toBe(true);

  await userEvent.click(
    within(card).getByRole("radio", { name: /Persist the draft in the view model/ }),
  );
  await userEvent.click(answer);
  await waitFor(() =>
    expect(app.daemon.isPending("thread-sheet-rotate", "ask-recovery")).toBe(false),
  );
  expect(app.daemon.resolution("thread-sheet-rotate", "ask-recovery")).toEqual({
    kind: "question",
    answers: { recovery: ["persist"] },
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("article", { name: "How should the sheet recover after rotate?" }),
    ).toBeNull(),
  );
});
