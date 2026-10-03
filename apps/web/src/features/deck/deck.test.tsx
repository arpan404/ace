import { workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const planGate = "Deck plan needs your approval";
const decks = () => screen.getByRole("navigation", { name: "Decks" });
const section = (name: string) => within(decks()).getByRole("region", { name });
const card = (name: RegExp) => screen.getByRole("button", { name });

/** The design's daemon: four decks on the conductor, served over the wire. */
async function open(path: string) {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open(path);
  return app;
}

test("Deck opens on a gated deck and approving its plan deals the split card", async () => {
  await open("/deck");

  const gate = await screen.findByRole("region", { name: planGate });
  expect(screen.getByRole("heading", { level: 1, name: "Resumable relay streams" })).toBeTruthy();
  expect(within(section("Gated")).getByText("Resumable relay streams")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Simulator replay test/ })).toBeNull();

  await userEvent.click(within(gate).getByRole("button", { name: "Approve plan" }));

  await waitFor(() => expect(screen.queryByRole("region", { name: planGate })).toBeNull());
  expect(card(/Simulator replay test/).textContent).toContain("Planned");
  expect(card(/Mobile cold-start replay/).textContent).toContain("Fixing, round 3");
  expect(within(section("Active")).getByText("Resumable relay streams")).toBeTruthy();
});

test("a plan gate's Review plan shows the plan, and Reject asks before it sends", async () => {
  await open("/deck/relay-streams");
  const gate = await screen.findByRole("region", { name: planGate });

  await userEvent.click(within(gate).getByRole("button", { name: "Review plan" }));
  const review = await screen.findByRole("dialog", { name: "The deck's plan" });
  const cards = within(within(review).getByRole("list", { name: "Cards in this plan" }));
  const titles = cards.getAllByRole("listitem").map((item) => item.firstChild?.textContent);
  expect(titles).toContain("Client ack and buffer flush");
  await userEvent.click(within(review).getByRole("button", { name: "Close" }));

  await userEvent.click(within(gate).getByRole("button", { name: "More decisions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Reject…" }));
  const confirm = await screen.findByRole("dialog", { name: "Reject this plan?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  // Nothing was sent: the gate stays open.
  expect(screen.queryByText("Rejected · the deck keeps its current course")).toBeNull();
  expect(screen.getByRole("region", { name: planGate })).toBeTruthy();
});

test("the plan ends in the merge, which waits for every card", async () => {
  await open("/deck/relay-streams");
  await screen.findByRole("region", { name: planGate });
  const merge = screen.getByRole("region", { name: "Merge" });
  expect(merge.textContent).toMatch(/Needs all \d+/);
});

test("a card's lane names its accounts from the daemon and lists its review rounds", async () => {
  await open("/deck/relay-streams");
  await screen.findByRole("region", { name: planGate });

  await userEvent.click(card(/Client ack and buffer flush/));

  const lane = screen.getByRole("region", { name: "Lane: Client ack and buffer flush" });
  const agents = within(await within(lane).findByRole("list", { name: /^Agents on/ }));
  expect(agents.getByRole("listitem", { name: "Worker, round 2: Codex · Personal" })).toBeTruthy();
  expect(
    agents.getByRole("listitem", { name: "Reviewer, round 2: Claude Code · Work" }),
  ).toBeTruthy();
  const rounds = within(within(lane).getByRole("list", { name: "Review rounds" }));
  expect(rounds.getAllByRole("listitem").map((round) => round.textContent)).toEqual([
    "Round 1Changes required",
    "Round 2Fixing",
  ]);
  expect(card(/Client ack and buffer flush/).ariaPressed).toBe("true");
});

test("each of a card's delegated agents opens its own thread", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "thread-dedupe",
    workspaceId: "ace",
    title: "Client ack",
    provider: "codex",
  });
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/deck/relay-streams?card=client-ack");

  const lane = await screen.findByRole("region", { name: "Lane: Client ack and buffer flush" });
  const reviewer = await within(lane).findByRole("listitem", { name: /^Reviewer/ });
  await userEvent.click(within(reviewer).getByRole("link", { name: /Open the reviewer/ }));

  expect(
    await screen.findByRole("heading", { level: 1, name: "Deck reviewer: client-ack" }),
  ).toBeTruthy();
});

test("approving an escalation lets its card carry on and clears the deck's gate", async () => {
  await open("/deck/mobile-cold-start");

  const gate = await screen.findByRole("region", { name: "Escalated: Defer the first relay sync" });
  expect(within(gate).getByText(/leaves the inbox empty/)).toBeTruthy();
  expect(card(/Defer the first relay sync/).textContent).toContain("Waiting for you");

  await userEvent.click(within(gate).getByRole("button", { name: "Approve" }));

  await waitFor(() => expect(card(/Defer the first relay sync/).textContent).toContain("Fixing"));
  expect(screen.queryByRole("region", { name: /^Escalated/ })).toBeNull();
});

test("pausing a deck stops it until it is resumed", async () => {
  await open("/deck/mobile-cold-start");
  await userEvent.click(await screen.findByRole("button", { name: "Pause deck" }));

  const resume = await screen.findByRole("button", { name: "Resume deck" });
  expect(screen.queryByRole("button", { name: "Pause deck" })).toBeNull();
  await userEvent.click(resume);
  expect(await screen.findByRole("button", { name: "Pause deck" })).toBeTruthy();
});

test("Lanes lists every card of the plan, merged and not yet dealt ones included", async () => {
  await open("/deck/relay-streams");
  await screen.findByRole("region", { name: planGate });
  await userEvent.click(screen.getByRole("button", { name: "Lanes" }));

  const lanes = screen.getByRole("list", { name: "Lanes" });
  expect(within(lanes).getAllByRole("button")).toHaveLength(6);
  expect(
    within(lanes).getByRole("button", { name: /^Migration note and docs/ }).textContent,
  ).toContain("Not dealt yet");
  expect(
    within(lanes).getByRole("button", { name: /Sequence numbers on every event/ }).textContent,
  ).toContain("Round 1 · Approved");
  await userEvent.click(within(lanes).getByRole("button", { name: /^Reconnect soak test/ }));

  expect(await screen.findByRole("region", { name: "Lane: Reconnect soak test" })).toBeTruthy();
});

test("the project filter narrows the deck list", async () => {
  await open("/deck/relay-streams");
  await screen.findByRole("region", { name: planGate });

  await userEvent.click(screen.getByRole("button", { name: "Project: All projects" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "ace-mobile" }));

  await waitFor(() => expect(within(decks()).queryByText("Resumable relay streams")).toBeNull());
  expect(within(decks()).getByText("Mobile cold start under 1s")).toBeTruthy();
});

test("a daemon without decks invites the first one", async () => {
  await harness().open("/deck");

  expect(
    await screen.findByRole("heading", { name: "Deal a goal to a team of agents" }),
  ).toBeTruthy();
  expect(screen.getByText("No decks yet")).toBeTruthy();
});

test("when the daemon can't list decks, Deck says so instead of inviting a first deck", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  app.daemon.failRequests("conductor.request");
  await app.open("/deck");

  const main = within(await screen.findByRole("main"));
  expect(
    await main.findByText("The daemon didn't answer. This loads again once it does."),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Deal a goal to a team of agents" })).toBeNull();
  expect(screen.getByText("Couldn't load the list.")).toBeTruthy();

  app.daemon.restoreRequests();
  await userEvent.click(main.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("navigation", { name: "Decks" })).toBeTruthy();
});

test("after the daemon connection drops, a deck follows the conductor again", async () => {
  const app = await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: "Escalated: Defer the first relay sync" });

  app.daemon.disconnectAll();
  await userEvent.click(await screen.findByRole("button", { name: "Pause deck" }));

  expect(await screen.findByRole("button", { name: "Resume deck" })).toBeTruthy();
});
