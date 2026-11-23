import { childStatus, delegatedQuestion, delegatedQuestionIds } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { harness } from "@/test/harness.tsx";
import { chooseEffort, closeModelControl, openEffortControl } from "@/test/model-control.ts";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

const { parent, child } = delegatedQuestionIds;

/** The parent thread open, while its delegated Codex child waits on the person's answer. */
async function openParent() {
  const app = harness();
  for (const scenario of delegatedQuestion()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${parent}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  return { app, feed, region };
}

test("a delegated child's question shows in the parent's strip, named, and answering it there resolves the child", async () => {
  const { app, region } = await openParent();
  const card = await within(region).findByRole("article", {
    name: "Should the review include the archived blog posts?",
  });
  // Who asks is said aloud; the strip itself shows only the question.
  expect(within(card).getByText("general assistant is asking").className).toContain("sr-only");

  await userEvent.click(within(card).getByRole("radio", { name: "Skip the archive" }));
  await userEvent.click(within(card).getByRole("button", { name: "Continue" }));

  await waitFor(() =>
    expect(app.daemon.resolution(child, "pages")).toEqual({
      kind: "question",
      answers: { scope: ["no"] },
    }),
  );
  expect(app.daemon.isPending(child, "pages")).toBe(false);
});

test("a delegated child's open request lives in the strip and row, never on the transcript's live line", async () => {
  const { app, feed } = await openParent();
  // Waiting on you lives in Summary and the composer's strip, never on the turn's head line.
  expect(within(feed).queryByRole("group", { name: "Turn in progress" })).toBeNull();
  expect(within(feed).queryByText(/Waiting for your answer/)).toBeNull();
  const row = await within(await screen.findByRole("navigation", { name: "Projects" })).findByRole(
    "link",
    { name: /^Site review/ },
  );
  expect(row.getAttribute("aria-label")).toContain("general assistant needs you");

  const region = screen.getByRole("region", { name: "Waiting for you" });
  const card = await within(region).findByRole("article", {
    name: "Should the review include the archived blog posts?",
  });
  await userEvent.click(within(card).getByRole("radio", { name: "Include them" }));
  await userEvent.click(within(card).getByRole("button", { name: "Continue" }));
  // The child goes back to work once answered; the daemon follows it in the parent's tree.
  await waitFor(() => expect(app.daemon.isPending(child, "pages")).toBe(false));
  app.daemon.apply(parent, [childStatus({ state: "working", agents: 1 })]);

  await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull());
  expect(within(feed).queryByText(/Waiting for your answer/)).toBeNull();
  expect(row.getAttribute("aria-label")).not.toContain("needs you");
});

test("a plain message typed while the child asks goes to the parent now, shows Working for on its turn head, and keeps the child's question in the strip", async () => {
  const { app, feed, region } = await openParent();
  await within(region).findByRole("article", {
    name: "Should the review include the archived blog posts?",
  });
  await userEvent.type(
    screen.getByRole("combobox", { name: "Message" }),
    "Check the pricing page first{Enter}",
  );

  // The parent is between turns: a delegated child never holds the person's message
  // (ADR 0053, 2026-10-17 amendment), so it starts the parent's next turn instead of queueing.
  expect(await within(feed).findByText("Check the pricing page first")).toBeTruthy();
  const head = await within(feed).findByRole("group", { name: "Turn in progress" });
  await waitFor(() => expect(head.textContent).toMatch(/^Working for /));
  expect(within(feed).queryByText(/Waiting for your answer/)).toBeNull();
  expect(screen.queryByRole("button", { name: /queued message/ })).toBeNull();
  expect(within(region).queryByText(/queued message/)).toBeNull();
  expect(
    within(region).getByRole("article", {
      name: "Should the review include the archived blog posts?",
    }),
  ).toBeTruthy();
  expect(app.daemon.isPending(child, "pages")).toBe(true);
});

test("a message that changes the effort while the child asks waits in the queue, and the strip says it sends once the child is done", async () => {
  const { app, feed, region } = await openParent();
  await within(region).findByRole("article", {
    name: "Should the review include the archived blog posts?",
  });
  const popover = await openEffortControl();
  await chooseEffort(popover, "{End}");
  await closeModelControl();
  await userEvent.type(
    screen.getByRole("combobox", { name: "Message" }),
    "Check the pricing page first{Enter}",
  );

  // A new effort may reopen the session, so it waits for the whole tree, the asking child
  // included. The question keeps the strip; the queued message is its indicator, and the card
  // says when it goes instead of leaving it to sit there unexplained.
  await screen.findByRole("button", { name: "Show 1 queued message" });
  expect(
    await within(region).findByText("Your queued message sends once general assistant is done."),
  ).toBeTruthy();
  expect(within(feed).queryByText("Check the pricing page first")).toBeNull();
  expect(app.daemon.isPending(child, "pages")).toBe(true);
});

test("a child request the strip can't answer in place says who needs you and opens the child", async () => {
  const app = harness();
  const [parentScenario] = delegatedQuestion();
  if (!parentScenario) throw new Error("lost the parent scenario");
  // Only the parent: the child's thread (another device's, say) isn't there to answer from.
  app.play(parentScenario).runUntilBlocked();
  await app.open(`/t/${parent}`);
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  expect(await within(region).findByText("general assistant needs you")).toBeTruthy();
  const open = within(region).getByRole("link", { name: "Open" });
  expect(open.getAttribute("href")).toBe(`/t/${child}`);
});
