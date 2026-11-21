import { act, configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { openNew, spadeApp, withEndpoint } from "@/test/spade.ts";
import { findMarket, openApp, seed } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

const press = (keys: string) => userEvent.keyboard(keys);
const withMarket = {
  daemon: (daemon: import("@ace/fake-daemon").FakeDaemon) =>
    daemon.seedServices({ marketplace: seed }),
};

test("the rail's Marketplace opens its page, on Home", async () => {
  await openApp("/chats");
  await userEvent.click(await screen.findByRole("button", { name: "Marketplace" }));
  const market = await findMarket();
  expect(within(market).getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe(
    "page",
  );
});

test("New bot's From the marketplace opens its page on Bots", async () => {
  await spadeApp(
    "/spade",
    (api) => {
      withEndpoint(api);
      api.teams.templates.push({
        id: "digest",
        name: "Morning digest",
        blurb: "Your feeds, summed up.",
        task: "Summarise my feeds.",
        face: { kind: "character", v: 1, body: "bird", pair: "sky", marking: "cap" },
        model_kind: "fast",
        routines: [],
      });
    },
    withMarket,
  );
  await openNew("New bot");
  const start = within(await screen.findByRole("region", { name: "Start from" }));
  await userEvent.click(start.getByRole("button", { name: "Marketplace" }));
  const market = await findMarket();
  expect(within(market).getByRole("button", { name: "Bots" }).getAttribute("aria-current")).toBe(
    "page",
  );
});

test("Appearance's More Suits opens its page on Looks", async () => {
  await openApp("/settings/appearance");
  await userEvent.click(await screen.findByRole("button", { name: "More Suits" }));
  const market = await findMarket();
  expect(within(market).getByRole("button", { name: "Looks" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(await within(market).findByRole("button", { name: "Harbour dusk" })).toBeTruthy();
});

test("Skills' Add menu opens its page on Tools", async () => {
  await openApp("/skills");
  await userEvent.click(await screen.findByRole("button", { name: "Add a skill" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "From the marketplace" }));
  const market = await findMarket();
  expect(within(market).getByRole("button", { name: "Tools" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(await within(market).findByRole("button", { name: "Triage mail" })).toBeTruthy();
});

test("a link into an entry opens its page, and ⌘[ goes back to its place", async () => {
  const { history } = await openApp("/chats?market=bot/inbox");
  const market = await findMarket();
  expect(await within(market).findByRole("heading", { level: 1, name: "Inbox" })).toBeTruthy();
  expect(within(market).getByRole("navigation", { name: "Back" }).textContent).toContain("Bots");

  await press("{Meta>}[[{/Meta}");
  expect(await within(market).findByRole("region", { name: "From publishers" })).toBeTruthy();
  expect(history.location.pathname).toBe("/market");
  expect(new URLSearchParams(history.location.search).get("at")).toBe("bots");

  // A link followed from anywhere lands where it points, on the Marketplace's page.
  act(() => history.push("/chats?market=suit/harbour-dusk"));
  expect(await screen.findByRole("heading", { level: 1, name: "Harbour dusk" })).toBeTruthy();
  expect(new URLSearchParams(history.location.search).get("at")).toBe("suit/harbour-dusk");
});
