import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

/*
 * Settings › Spade › Apps, Outside agents (ADR 0202 §5): the person adds an A2A agent by its
 * address; the row says whether its card was signed by its publisher's key and that each call
 * asks them; an address Spade can't use is refused with Spade's words; Remove takes it away.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const address = "https://agents.example.com";

function seed(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  api.a2aAgents.cards.set(address, {
    id: "travel-desk",
    name: "Travel desk",
    address: `${address}/.well-known/agent-card.json`,
    signed: false,
    signature: "Not signed",
    unsigned_because: "its signature doesn't match the card, which changed after it was signed",
    skills: [{ id: "book", name: "Book" }],
  });
  api.a2aAgents.refusals.set("http://agents.example.com", "Spade reaches agents over https only.");
}

const section = async () => within(await screen.findByRole("region", { name: "Outside agents" }));

test("an agent added by its address shows whether its card was signed, and Remove takes it", async () => {
  const { spade } = await spadeApp("/settings/spade/apps", seed);
  const agents = await section();
  await userEvent.click(agents.getByRole("button", { name: "Add an agent" }));
  await userEvent.type(agents.getByLabelText("Agent address"), "http://agents.example.com");
  await userEvent.click(agents.getByRole("button", { name: "Add" }));
  expect(await agents.findByText("Spade reaches agents over https only.")).toBeTruthy();

  await userEvent.clear(agents.getByLabelText("Agent address"));
  await userEvent.type(agents.getByLabelText("Agent address"), address);
  await userEvent.click(agents.getByRole("button", { name: "Add" }));
  expect(await agents.findByText("Travel desk")).toBeTruthy();
  expect(agents.getByText("Not signed")).toBeTruthy();
  expect(agents.getByText("Book · Each call asks you first")).toBeTruthy();
  expect(spade.sent("POST", "/v1/a2a-agents")).toEqual([
    { address: "http://agents.example.com" },
    { address },
  ]);

  await userEvent.click(agents.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(agents.queryByText("Travel desk")).toBeNull());
  expect(spade.sent("DELETE", "/v1/a2a-agents/travel-desk")).toHaveLength(1);
});
