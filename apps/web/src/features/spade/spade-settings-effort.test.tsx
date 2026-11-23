import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function withFlights(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.addAgent({ id: "flights", name: "Flights", model: "openrouter/saved/model" });
}

async function choose(select: string, option: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("each role's thinking shows its default until the person sets it for every bot", async () => {
  const { spade } = await spadeApp("/settings/spade/models", withFlights);
  const roles = within(await screen.findByRole("region", { name: "Roles" }));
  const review = await roles.findByRole("combobox", { name: "Reviewing steps thinking" });
  expect(review.textContent).toContain("Default: medium thinking");
  expect(roles.getByRole("combobox", { name: "Titles thinking" }).textContent).toContain(
    "Default: low thinking",
  );

  await choose("Reviewing steps thinking", "High thinking");
  await choose("Bots' own turns thinking", "Provider's thinking");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/models/roles")).toEqual([
      { efforts: { review: "high" } },
      { efforts: { main: "provider" } },
    ]),
  );
  await waitFor(() => expect(review.textContent).toContain("High thinking"));

  // Back to the default: saved as null, so the role follows it again.
  await choose("Reviewing steps thinking", "Default: medium thinking");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/models/roles").at(-1)).toEqual({ efforts: { review: null } }),
  );
});

test("a bot's role follows Settings' thinking until the person sets it on the bot", async () => {
  const { spade } = await spadeApp("/spade/flights?profile=details", (api) => {
    withFlights(api);
    api.roles.globalEfforts = { helper: "high" };
  });
  const panel = within(await screen.findByRole("region", { name: "Flights's profile" }));
  await userEvent.click(await panel.findByText("Models for other work"));
  const helpers = await panel.findByRole("combobox", { name: "Helpers thinking" });
  expect(helpers.textContent).toContain("As in Settings: high thinking");
  expect(panel.getByRole("combobox", { name: "Its own turns thinking" }).textContent).toContain(
    "As in Settings: medium thinking",
  );

  await choose("Its own turns thinking", "No thinking");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/flights/models")).toEqual([{ efforts: { main: "off" } }]),
  );
  await waitFor(() =>
    expect(panel.getByRole("combobox", { name: "Its own turns thinking" }).textContent).toContain(
      "No thinking",
    ),
  );
});
