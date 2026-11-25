import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint, openSettingsPage } from "@/test/spade.ts";

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
  await openSettingsPage("Model");
  const panel = within(await screen.findByRole("region", { name: "Flights's profile" }));
  // One row per role, its model and effort in one line; a row opens its page.
  const row = await panel.findByRole("button", { name: /Helpers/ });
  expect(row.textContent).toContain("Same as main · High");
  await userEvent.click(row);
  const helpers = await panel.findByRole("combobox", { name: "Helpers thinking" });
  expect(helpers.textContent).toContain("As in Settings: high thinking");

  await choose("Helpers thinking", "No thinking");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/flights/models")).toEqual([
      { efforts: { helper: "off" } },
    ]),
  );
  await waitFor(() => expect(helpers.textContent).toContain("No thinking"));
});

test("the Thinking control offers the model's efforts and is absent for a model with none", async () => {
  const { spade } = await spadeApp("/spade/flights?profile=details", (api) => {
    withFlights(api);
    const saved = (api.endpoints[0]?.models as object[] | undefined)?.[0];
    if (saved) Object.assign(saved, { efforts: ["low", "medium", "high"] });
  });
  await openSettingsPage("Model");
  const panel = within(await screen.findByRole("region", { name: "Flights's profile" }));
  const thinking = await panel.findByRole("group", { name: "Thinking" });
  expect(
    within(thinking)
      .getAllByRole("button")
      .map((each) => each.textContent),
  ).toEqual(["Low", "Medium", "High"]);
  await userEvent.click(within(thinking).getByRole("button", { name: "High" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/flights/models")).toEqual([{ efforts: { main: "high" } }]),
  );
});

test("no Thinking control shows for a model that declares no efforts", async () => {
  await spadeApp("/spade/flights?profile=details", withFlights);
  await openSettingsPage("Model");
  const panel = within(await screen.findByRole("region", { name: "Flights's profile" }));
  await panel.findByRole("button", { name: /Helpers/ });
  expect(panel.queryByRole("group", { name: "Thinking" })).toBeNull();
});
