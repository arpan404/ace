import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openActivity() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  // Decks, automation runs and the pull requests linked to the threads.
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/activity");
  const sidebar = await screen.findByRole("complementary", { name: "Activity" });
  const feed = await within(sidebar).findByRole("list", { name: "Activity" });
  await within(feed).findByText("Install @fontsource/noto-sans-jp?");
  return { app, sidebar, feed };
}

const tab = (name: RegExp | string) => screen.getByRole("tab", { name });

test("the feed lists what needs you first, then CI, mentions, pull requests and automation results", async () => {
  const { feed } = await openActivity();
  await within(feed).findByText("Checks failed on #74");
  const titles = within(feed)
    .getAllByRole("button")
    .map((row) => row.textContent ?? "");
  const index = (text: string) => titles.findIndex((title) => title.includes(text));
  expect(index("Allow a force push")).toBeGreaterThanOrEqual(0);
  expect(index("Escalated: Defer the first relay sync")).toBeGreaterThan(
    index("Allow a force push"),
  );
  expect(index("Checks failed on #74")).toBeGreaterThan(
    index("Escalated: Defer the first relay sync"),
  );
  expect(index("PR #212 merged")).toBeGreaterThan(index("Checks failed on #74"));
  expect(index("Review pull requests on open")).toBeGreaterThan(0);
  expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
  // Three thread requests, the relay deck's plan, and the mobile deck's escalation and question.
  expect(screen.getByText("6 need you")).toBeTruthy();
  expect(within(tab(/Needs you/)).getByText("6")).toBeTruthy();
});

test("tabs narrow the feed to mentions or to automation results", async () => {
  const { feed } = await openActivity();

  await within(feed).findByText("Checks failed on #74");
  await userEvent.click(tab("Mentions"));
  expect(
    within(feed).getByText("mira: @you Which port does the daemon default to in docker?"),
  ).toBeTruthy();
  expect(within(feed).queryByText("Checks failed on #74")).toBeNull();
  expect(within(feed).queryByText("Allow a force push to fix/restart-retry?")).toBeNull();

  await userEvent.click(tab("Automations"));
  expect(await within(feed).findByText("Failed: npm registry timeout, retried once")).toBeTruthy();
  expect(
    within(feed).queryByText("mira: @you Which port does the daemon default to in docker?"),
  ).toBeNull();

  await userEvent.click(tab(/Needs you/));
  expect(within(feed).getByText("How should the sheet recover after rotate?")).toBeTruthy();
  expect(within(feed).queryByText("PR #212 merged")).toBeNull();
});

test("an approval is answerable from its feed row without opening the card", async () => {
  const { app, feed } = await openActivity();
  const row = within(feed).getByText("Install @fontsource/noto-sans-jp?").closest("li");
  if (!row) throw new Error("row not found");

  await userEvent.click(within(row).getByRole("button", { name: "Deny" }));

  await waitFor(() =>
    expect(app.daemon.resolution("thread-refund-tax", "approve-font")).toEqual({
      kind: "approval",
      optionId: "deny",
    }),
  );
  await waitFor(() =>
    expect(within(feed).queryByText("Install @fontsource/noto-sans-jp?")).toBeNull(),
  );
  expect(screen.getByText("5 need you")).toBeTruthy();
});

test("selecting a feed row focuses its card in Needs you", async () => {
  const { feed } = await openActivity();
  await userEvent.click(within(feed).getByText("How should the sheet recover after rotate?"));
  const question = screen.getByRole("article", {
    name: "How should the sheet recover after rotate?",
  });
  expect(question.getAttribute("aria-current")).toBe("true");
});

test("Mark all read quiets every feed row and then has nothing left to do", async () => {
  const { feed } = await openActivity();
  await within(feed).findByText("Checks failed on #74");
  const markAll = screen.getByRole("button", { name: "Mark all read" });
  const row = (text: string) => {
    const li = within(feed).getByText(text).closest("li");
    if (!li) throw new Error(`No row for ${text}`);
    return within(li);
  };
  expect(row("Checks failed on #74").getByText("Unread")).toBeTruthy();

  await userEvent.click(markAll);

  expect(row("Checks failed on #74").queryByText("Unread")).toBeNull();
  expect(row("PR #212 merged").queryByText("Unread")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Mark all read" }).disabled).toBe(
    true,
  );
  // Requests that still need you stay prominent.
  expect(row("Allow a force push to fix/restart-retry?").getByText("Needs you")).toBeTruthy();
});

test("approving a deck's escalation clears it from Needs you", async () => {
  const { feed } = await openActivity();
  const name = "Escalated: Defer the first relay sync";
  const escalation = await screen.findByRole("article", { name });
  expect(within(escalation).getByText(/leaves the inbox empty/)).toBeTruthy();

  await userEvent.click(within(escalation).getByRole("button", { name: /^Approve/ }));

  await waitFor(() => expect(screen.queryByRole("article", { name })).toBeNull());
  expect(await screen.findByText("Approve · the deck carries on")).toBeTruthy();
  expect(screen.getByText("5 need you")).toBeTruthy();
  // The deck has moved on: nothing about the decision is left to answer.
  expect(within(feed).queryByText(name)).toBeNull();
});

test("a deck worker's question is answered from Needs you, under its deck's name", async () => {
  const { app, feed } = await openActivity();
  const name = "Ship the precompiled bytecode in the APK, or build it on the first launch?";
  const asking = await screen.findByRole("article", { name });
  expect(within(asking).getByText(/Mobile cold start under 1s/)).toBeTruthy();
  // Its feed row names the deck's card, and the deck's own threads aren't listed again.
  expect(within(feed).getByText("Precompile Hermes bytecode needs your answer")).toBeTruthy();
  expect(within(feed).queryByText("Deck needs your decision")).toBeNull();

  await userEvent.click(within(asking).getByRole("button", { name: /Ship it in the APK/ }));

  await waitFor(() => expect(screen.queryByRole("article", { name })).toBeNull());
  expect(
    app.daemon.resolution("mobile-cold-start.hermes-bytecode.thread", "ask.hermes-bytecode"),
  ).toEqual({ kind: "question", answers: { choice: ["apk"] } });
  expect(screen.getByText("5 need you")).toBeTruthy();
});

test("the project filter narrows both the feed and the cards", async () => {
  const { feed } = await openActivity();
  await within(feed).findByText("Checks failed on #74");

  await userEvent.click(screen.getByRole("button", { name: "Filter" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "billing-api" }));

  await waitFor(() =>
    expect(
      screen.queryByRole("article", { name: "Allow a force push to fix/restart-retry?" }),
    ).toBeNull(),
  );
  expect(screen.getByRole("article", { name: "Install @fontsource/noto-sans-jp?" })).toBeTruthy();
  expect(within(feed).getByText("Checks failed on #74")).toBeTruthy();
  expect(within(feed).queryByText("PR #212 merged")).toBeNull();
  expect(screen.getByRole("button", { name: "Filter: billing-api" })).toBeTruthy();
});
