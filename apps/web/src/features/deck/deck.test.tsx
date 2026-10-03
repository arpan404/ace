import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const gateName = "Deck plan needs your approval";
const decks = () => screen.getByRole("navigation", { name: "Decks" });
const section = (name: string) => within(decks()).getByRole("region", { name });

test("Deck opens on the gated deck and approving its plan revision deals the split card", async () => {
  await harness().open("/deck");

  const gate = await screen.findByRole("region", { name: gateName });
  expect(screen.getByRole("heading", { level: 1, name: "Resumable relay streams" })).toBeTruthy();
  expect(within(section("Gated")).getByText("Resumable relay streams")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Simulator replay test/ })).toBeNull();

  await userEvent.click(within(gate).getByRole("button", { name: "Approve plan" }));

  await waitFor(() => expect(screen.queryByRole("region", { name: gateName })).toBeNull());
  expect(screen.getByRole("button", { name: /Simulator replay test/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Mobile cold-start replay/ }).textContent).toContain(
    "Working",
  );
  expect(within(section("Active")).getByText("Resumable relay streams")).toBeTruthy();
  expect(within(decks()).queryByRole("region", { name: "Gated" })).toBeNull();
});

test("selecting a card shows its lane: worker, reviewer and each round's findings", async () => {
  await harness().open("/deck/relay-streams");

  const fixing = await screen.findByRole("region", { name: "Lane: Client ack and buffer flush" });
  expect(within(fixing).getByText("Codex · personal")).toBeTruthy();
  expect(within(fixing).getByText(/Buffer is cleared before the resume.ack arrives/)).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: /Mobile cold-start replay/ }));

  const lane = screen.getByRole("region", { name: "Lane: Mobile cold-start replay" });
  expect(within(lane).getByText("Gemini CLI · google")).toBeTruthy();
  expect(within(lane).getByText("Waiting for you")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Mobile cold-start replay/ }).ariaPressed).toBe("true");
});

test("Review changes lists the plan revision in the right panel", async () => {
  await harness().open("/deck/relay-streams");
  const gate = await screen.findByRole("region", { name: gateName });

  await userEvent.click(within(gate).getByRole("button", { name: "Review changes" }));

  const changes = await screen.findByRole("list", { name: "Plan changes" });
  expect(within(changes).getByText("Simulator replay test")).toBeTruthy();
  expect(within(changes).getByText(/Runs on this Mac instead of build-box/)).toBeTruthy();
});

test("rejecting a plan revision keeps the current plan and is recorded in the log", async () => {
  await harness().open("/deck/relay-streams");
  const gate = await screen.findByRole("region", { name: gateName });

  await userEvent.click(within(gate).getByRole("button", { name: "Reject" }));

  await waitFor(() => expect(screen.queryByRole("region", { name: gateName })).toBeNull());
  expect(screen.queryByRole("button", { name: /Simulator replay test/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Log" }));
  const log = screen.getByRole("list", { name: "Deck log" });
  expect(within(log).getAllByRole("listitem")[0]?.textContent).toContain(
    "You rejected plan revision 2",
  );
});

test("pausing a deck stops it until it is resumed", async () => {
  await harness().open("/deck/mobile-cold-start");
  await userEvent.click(await screen.findByRole("button", { name: "Pause deck" }));

  expect(await within(decks()).findByText(/Paused · 1 of 4 merged/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Resume deck" }));
  expect(await within(decks()).findByText("Dealing · 3 lanes active")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pause deck" })).toBeTruthy();
});

test("Lanes lists every card of the plan, merged and not yet dealt ones included, and opening one shows it on the plan", async () => {
  await harness().open("/deck/relay-streams");
  await userEvent.click(await screen.findByRole("button", { name: "Lanes" }));

  const lanes = screen.getByRole("list", { name: "Lanes" });
  expect(within(lanes).getAllByRole("button")).toHaveLength(7);
  expect(
    within(lanes).getByRole("button", { name: /^Migration note and docs/ }).textContent,
  ).toContain("Not dealt yet");
  expect(
    within(lanes).getByRole("button", { name: /Sequence numbers on every event/ }).textContent,
  ).toContain("Approved · merged as #211");
  await userEvent.click(within(lanes).getByRole("button", { name: /^Reconnect soak test/ }));

  const lane = await screen.findByRole("region", { name: "Lane: Reconnect soak test" });
  expect(within(lane).getByText(/212 of 500 reconnects/)).toBeTruthy();
});

test("the project filter narrows the deck list", async () => {
  await harness().open("/deck/relay-streams");
  await screen.findByRole("region", { name: gateName });

  await userEvent.click(screen.getByRole("button", { name: "Project: All projects" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "ace-mobile" }));

  await waitFor(() => expect(within(decks()).queryByText("Resumable relay streams")).toBeNull());
  expect(within(decks()).getByText("Mobile cold start under 1s")).toBeTruthy();
});
