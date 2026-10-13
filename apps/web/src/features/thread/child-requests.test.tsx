import { childStatus, delegatedQuestion, delegatedQuestionIds } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { harness } from "@/test/harness.tsx";

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
  expect(card.textContent).toContain("general assistant");

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

test("the parent reads Waiting for your answer, naming the child, only while the child's request is open", async () => {
  const { app, feed } = await openParent();
  const head = within(feed).getByRole("group", { name: "Turn in progress" });
  await waitFor(() => expect(head.textContent).toBe("Waiting for your answer · general assistant"));
  const row = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
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

test("a message typed while the child asks waits in the queue, and the strip says it sends once the child is done", async () => {
  const { app, region } = await openParent();
  await within(region).findByRole("article", {
    name: "Should the review include the archived blog posts?",
  });
  await userEvent.type(
    screen.getByRole("combobox", { name: "Message" }),
    "Check the pricing page first{Enter}",
  );

  // The question keeps the strip; the queued message is its indicator, and the card says when
  // it goes instead of leaving it to sit there unexplained.
  await screen.findByRole("button", { name: "Show 1 queued message" });
  expect(
    await within(region).findByText("Your queued message sends once general assistant is done."),
  ).toBeTruthy();
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
