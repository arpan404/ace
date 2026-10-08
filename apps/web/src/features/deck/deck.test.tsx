import { deckRuns, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const mergeGate = "Merge needs your approval: Server-side replay cursor";
const escalation = "Escalated: Defer the first relay sync";
const decks = () => screen.getByRole("navigation", { name: "Offshifts" });
const section = (name: string) => within(decks()).getByRole("region", { name });
const card = (name: RegExp) => screen.getByRole("button", { name });

/** The design's daemon: four decks on the conductor, served over the wire. */
async function open(path: string, extra: Parameters<typeof deckRuns>[1] = []) {
  const app = harness();
  const now = Date.now();
  app.daemon.seedServices({ ...workbenchServices(now), decks: deckRuns(now, extra) });
  await app.open(path);
  return app;
}

test("Deck opens on the deck waiting on a decision; approving a card's merge deals what waited on it", async () => {
  await open("/offshifts");

  const gate = await screen.findByRole("region", { name: mergeGate });
  expect(screen.getByRole("heading", { level: 1, name: "Resumable relay streams" })).toBeTruthy();
  expect(within(section("Needs you")).getByText("Resumable relay streams")).toBeTruthy();
  expect(within(gate).getByText(/passed review at 9f2c41a/)).toBeTruthy();

  await userEvent.click(within(gate).getByRole("button", { name: /^Approve merge/ }));

  await waitFor(() => expect(screen.queryByRole("region", { name: mergeGate })).toBeNull());
  expect(card(/Server-side replay cursor/).textContent).toContain("Merged");
  expect(card(/Migration note and docs/).textContent).toContain("Working");
  expect(within(section("Active")).getByText("Resumable relay streams")).toBeTruthy();
});

test("declining a card's merge asks first, says what it does, and the deck carries on without it", async () => {
  await open("/offshifts/relay-streams");
  const gate = await screen.findByRole("region", { name: mergeGate });

  await userEvent.click(within(gate).getByRole("button", { name: "Decline card…" }));
  const confirm = await screen.findByRole("dialog", { name: "Decline Server-side replay cursor?" });
  expect(confirm.textContent).toContain("The rest of the offshift carries on.");
  await userEvent.click(within(confirm).getByRole("button", { name: "Decline card" }));

  expect(
    await screen.findByText("Declined Server-side replay cursor · the offshift carries on"),
  ).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("region", { name: mergeGate })).toBeNull());
  expect(card(/Server-side replay cursor/).textContent).toContain("Declined");
  // The card that needed it won't start, while the deck keeps dealing the rest.
  expect(card(/Migration note and docs/).textContent).toContain("Won't start");
  expect(card(/Client ack and buffer flush/).textContent).toContain("Fixing");
  expect(screen.getByRole("button", { name: "Pause offshift" })).toBeTruthy();
});

test("the plan ends in the merge, which waits for every card", async () => {
  await open("/offshifts/relay-streams");
  await screen.findByRole("region", { name: mergeGate });
  const merge = screen.getByRole("row", { name: "Merge" });
  expect(merge.textContent).toMatch(/Needs all \d+/);
});

test("a card's lane names its accounts, and its rounds carry the reviewer's verdicts", async () => {
  await open("/offshifts/relay-streams");
  await screen.findByRole("region", { name: mergeGate });

  await userEvent.click(card(/Client ack and buffer flush/));

  const lane = screen.getByRole("region", { name: "Lane: Client ack and buffer flush" });
  const agents = within(await within(lane).findByRole("list", { name: /^Agents on/ }));
  expect(agents.getByRole("listitem", { name: "Worker, round 2: Codex · Personal" })).toBeTruthy();
  expect(
    agents.getByRole("listitem", { name: "Reviewer, round 2: Claude Code · Work" }),
  ).toBeTruthy();
  const rounds = within(within(lane).getByRole("list", { name: "Review rounds" }));
  const [first, second] = rounds.getAllByRole("listitem");
  expect(first?.textContent).toContain("Changes required");
  expect(first?.textContent).toContain("Buffer is cleared before the resume.ack arrives");
  expect(second?.textContent).toContain("Fixing");
  expect(card(/Client ack and buffer flush/).ariaPressed).toBe("true");
});

test("arrow keys move between cards, Enter selects, and j and k step through the plan", async () => {
  await open("/offshifts/relay-streams");
  await screen.findByRole("region", { name: mergeGate });
  const first = card(/Sequence numbers on every event/);
  // One card in the plan is a tab stop; the rest are reached with the arrows.
  expect(
    screen.getByRole("grid", { name: "Plan" }).querySelectorAll('[tabindex="0"]'),
  ).toHaveLength(1);

  first.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement?.textContent).toMatch(/Server-side replay cursor/);
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.textContent).toMatch(/Client ack and buffer flush/);
  await userEvent.keyboard("{Enter}");
  expect(card(/Client ack and buffer flush/).ariaPressed).toBe("true");
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Cards" }));

  await userEvent.keyboard("j");
  await waitFor(() => expect(card(/Mobile cold-start replay/).ariaPressed).toBe("true"));
  await userEvent.keyboard("k");
  await waitFor(() => expect(card(/Client ack and buffer flush/).ariaPressed).toBe("true"));
});

test("an escalation's Retry card starts a new round for it and clears the deck's gate", async () => {
  await open("/offshifts/mobile-cold-start");

  const gate = await screen.findByRole("region", { name: escalation });
  expect(within(gate).getByText(/leaves the inbox empty/)).toBeTruthy();
  expect(card(/Defer the first relay sync/).textContent).toContain("Waiting for you");

  await userEvent.click(within(gate).getByRole("button", { name: /^Retry card/ }));

  await waitFor(() => expect(card(/Defer the first relay sync/).textContent).toContain("Fixing"));
  expect(
    await screen.findByText("Retrying Defer the first relay sync: a new round starts"),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: escalation })).toBeNull();
});

test("a used-up budget is raised from the gate, which sends a budget above the deck's", async () => {
  await open("/offshifts/settings-sync", ["budget"]);
  const gate = await screen.findByRole("region", { name: "The offshift used its budget" });
  expect(
    within(gate).getByText("50 of 50 lane starts used. Raise the budget to keep going."),
  ).toBeTruthy();
  expect(screen.getByText("50 of 50 lane starts")).toBeTruthy();

  const field = within(gate).getByRole("spinbutton", { name: "New budget" });
  await userEvent.clear(field);
  await userEvent.type(field, "40");
  expect(
    within(gate).getByRole("button", { name: "Raise the budget" }).hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.clear(field);
  await userEvent.type(field, "80");
  await userEvent.click(within(gate).getByRole("button", { name: "Raise to 80" }));

  expect(await screen.findByText("Budget raised to 80")).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "The offshift used its budget" })).toBeNull(),
  );
  // The daemon took the raised budget: the deck now reads against it.
  expect(await screen.findByText("50 of 80 lane starts")).toBeTruthy();
});

test("rejecting a budget is stopping the deck, and says so before it does", async () => {
  await open("/offshifts/settings-sync", ["budget"]);
  const gate = await screen.findByRole("region", { name: "The offshift used its budget" });

  await userEvent.click(within(gate).getByRole("button", { name: "More decisions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Stop the offshift…" }));
  const confirm = await screen.findByRole("dialog", { name: "Reject and cancel this offshift?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Cancel offshift" }));

  expect(await screen.findByText("This offshift was cancelled.")).toBeTruthy();
});

test("an unresponsive lane's escalation says what happened in words, with the daemon's line on request", async () => {
  await open("/offshifts/export-threads", ["unresponsive"]);
  const gate = await screen.findByRole("region", { name: "Escalated: Markdown writer" });

  expect(within(gate).getByText("Markdown writer's worker stopped responding.")).toBeTruthy();
  await userEvent.click(within(gate).getByText("Details"));
  expect(within(gate).getByText("Lane export-writer.worker is unresponsive")).toBeTruthy();
});

test("a plan gate's review shows each card's acceptance criteria, and approves from there", async () => {
  await open("/offshifts/search-ranking", ["planning"]);
  const gate = await screen.findByRole("region", { name: "Offshift plan needs your approval" });

  await userEvent.click(within(gate).getByRole("button", { name: "Review plan" }));
  const review = await screen.findByRole("dialog", { name: "The offshift's plan" });
  expect(within(review).getByText(/^3 cards in 2 stages/)).toBeTruthy();
  const judged = within(review).getByRole("list", { name: "How Recency score is judged" });
  expect(judged.textContent).toContain("A thread active today ranks above");

  await userEvent.click(within(review).getByRole("button", { name: /^Approve plan/ }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Offshift plan needs your approval" })).toBeNull(),
  );
  expect(card(/Recency score/).textContent).toContain("Working");
});

test("rejecting a plan drafts another instead of cancelling the deck", async () => {
  await open("/offshifts/search-ranking", ["planning"]);
  const gate = await screen.findByRole("region", { name: "Offshift plan needs your approval" });

  await userEvent.click(within(gate).getByRole("button", { name: "More decisions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Draft a new plan…" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Draft a new plan?" })).getByRole("button", {
      name: "Draft again",
    }),
  );

  expect(await screen.findByText("Drafting a new plan")).toBeTruthy();
  expect(await screen.findByText(/^Revision 2:/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pause offshift" })).toBeTruthy();
});

test("pausing a deck stops it until it is resumed", async () => {
  await open("/offshifts/mobile-cold-start");
  await userEvent.click(await screen.findByRole("button", { name: "Pause offshift" }));

  const resume = await screen.findByRole("button", { name: "Resume offshift" });
  expect(screen.queryByRole("button", { name: "Pause offshift" })).toBeNull();
  await userEvent.click(resume);
  expect(await screen.findByRole("button", { name: "Pause offshift" })).toBeTruthy();
});

test("Lanes groups the cards by what they need and opens a lane in place", async () => {
  await open("/offshifts/relay-streams?tab=lanes");
  const lanes = await screen.findByRole("table", { name: "Lanes" });

  const groups = within(lanes)
    .getAllByRole("rowgroup")
    .map((group) => group.getAttribute("aria-label"))
    .filter(Boolean);
  expect(groups).toEqual(["Needs you", "Working", "Planned", "Merged"]);
  expect(
    within(within(lanes).getByRole("rowgroup", { name: "Planned" })).getByRole("button", {
      name: /^Migration note and docs/,
    }).textContent,
  ).toContain("Not dealt yet");

  const soak = within(lanes).getByRole("button", { name: /^Reconnect soak test/ });
  await userEvent.click(soak);
  expect(soak.getAttribute("aria-expanded")).toBe("true");
  expect(await screen.findByRole("region", { name: "Lane: Reconnect soak test" })).toBeTruthy();
  // Still on Lanes: opening a lane doesn't switch to the plan.
  expect(screen.getByRole("table", { name: "Lanes" })).toBeTruthy();
});

test("the project filter narrows the deck list and is kept for the next visit", async () => {
  await open("/offshifts/relay-streams");
  await screen.findByRole("region", { name: mergeGate });

  await userEvent.click(screen.getByRole("button", { name: "Project: All projects" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "ace-mobile" }));

  await waitFor(() => expect(within(decks()).queryByText("Resumable relay streams")).toBeNull());
  expect(within(decks()).getByText("Mobile cold start under 1s")).toBeTruthy();
  expect(localStorage.getItem("ace.deck.filter")).toBe("ace-mobile");
  localStorage.removeItem("ace.deck.filter");
});

test("a daemon without decks invites the first one, once, in the main pane", async () => {
  await harness().open("/offshifts");

  expect(
    await screen.findByRole("heading", { name: "Deal a goal to a team of agents" }),
  ).toBeTruthy();
  expect(screen.queryByText("No offshifts yet")).toBeNull();
});

test("when the daemon can't list decks, Deck says so instead of inviting a first deck", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  app.daemon.failRequests("conductor.request");
  await app.open("/offshifts");

  const main = within(await screen.findByRole("main"));
  expect(await main.findByText("Couldn't reach the daemon's Offshifts service.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Deal a goal to a team of agents" })).toBeNull();
  expect(screen.getByText("Couldn't load the list.")).toBeTruthy();

  app.daemon.restoreRequests();
  await userEvent.click(main.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("navigation", { name: "Offshifts" })).toBeTruthy();
});

test("a deck that isn't on the daemon offers the way back and a new deck", async () => {
  await open("/offshifts/gone");
  const missing = await screen.findByRole("heading", {
    level: 1,
    name: "This offshift isn't here",
  });
  expect(missing).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to Offshifts" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "New offshift" })).toBeTruthy();
});

test("after the daemon connection drops, a deck follows the conductor again", async () => {
  const app = await open("/offshifts/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.disconnectAll();
  await userEvent.click(await screen.findByRole("button", { name: "Pause offshift" }));

  expect(await screen.findByRole("button", { name: "Resume offshift" })).toBeTruthy();
});

test("folding away the selected merged card keeps a way into the plan from the keyboard", async () => {
  const app = harness();
  const now = Date.now();
  const [, mobile] = deckRuns(now);
  if (!mobile) throw new Error("Seed deck missing");
  // Two merged cards in one stage, one of them selected.
  const cards = mobile.cards.map((c) =>
    c.id === "lazy-fonts" || c.id === "hermes-bytecode"
      ? { ...c, state: "merged" as const, question: null }
      : c,
  );
  app.daemon.seedServices({ decks: [{ ...mobile, cards }] });
  await app.open("/offshifts/mobile-cold-start?card=lazy-fonts");
  await screen.findByRole("region", { name: escalation });
  expect(card(/Lazy-load fonts and icons/).ariaPressed).toBe("true");

  const fold = screen.getByRole("button", { name: "Collapse merged" });
  await userEvent.click(fold);
  expect(screen.queryByRole("button", { name: /^Lazy-load fonts and icons/ })).toBeNull();

  await userEvent.tab();
  expect(document.activeElement?.textContent).toMatch(/Startup trace baseline/);
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement?.textContent).toMatch(/Defer the first relay sync/);
});

test("a stage of only merged cards folds into a chip that is reachable and unfolds them", async () => {
  await open("/offshifts/codex-app-server-048");
  await screen.findByRole("button", { name: /^Bump the protocol bindings/ });
  await userEvent.click(screen.getByRole("button", { name: "Collapse merged" }));

  await userEvent.tab();
  expect(document.activeElement?.textContent).toBe("2 merged");
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: /^Bump the protocol bindings/ })).toBeTruthy();
});
