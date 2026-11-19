import { act, configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { openNew, spadeApp, withEndpoint } from "@/test/spade.ts";
import { expectClosesOnEscape, findMarket, openApp, seed } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

const press = (keys: string) => userEvent.keyboard(keys);
const withMarket = {
  daemon: (daemon: import("@ace/fake-daemon").FakeDaemon) =>
    daemon.seedServices({ marketplace: seed }),
};

test("the rail's Marketplace opens the modal over the page, and Esc closes it", async () => {
  await openApp("/chats");
  await userEvent.click(await screen.findByRole("button", { name: "Marketplace" }));
  const market = await findMarket();
  expect(
    within(market).getByRole("button", { name: "Discover" }).getAttribute("aria-current"),
  ).toBe("page");
  await expectClosesOnEscape(press);
});

test("Spade's apps button opens the modal on Spade's types, without Looks", async () => {
  await spadeApp("/spade", () => {}, withMarket);
  await userEvent.click(await screen.findByRole("button", { name: "Apps, plugins and skills" }));
  const market = await findMarket();
  expect(within(market).queryByRole("button", { name: "Looks" })).toBeNull();
  expect(await within(market).findByRole("region", { name: "Bots" })).toBeTruthy();
  await expectClosesOnEscape(press);
});

test("New bot's From the marketplace opens the modal on Bots", async () => {
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
  await userEvent.click(await screen.findByRole("button", { name: "From the marketplace" }));
  const market = await findMarket();
  expect(within(market).getByRole("button", { name: "Bots" }).getAttribute("aria-current")).toBe(
    "page",
  );
  await expectClosesOnEscape(press);
});

test("Appearance's More Suits opens the modal on Looks", async () => {
  await openApp("/settings/appearance");
  await userEvent.click(await screen.findByRole("button", { name: "More Suits" }));
  const market = await findMarket();
  expect(within(market).getByRole("button", { name: "Looks" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(await within(market).findByRole("button", { name: "Harbour dusk" })).toBeTruthy();
  await expectClosesOnEscape(press);
});

test("Skills' Add menu opens the modal on Tools", async () => {
  await openApp("/skills");
  await userEvent.click(await screen.findByRole("button", { name: "Add a skill" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "From the marketplace" }));
  const market = await findMarket();
  expect(within(market).getByRole("button", { name: "Tools" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(await within(market).findByRole("button", { name: "Triage mail" })).toBeTruthy();
  await expectClosesOnEscape(press);
});

test("a link into an entry opens its page, and ⌘[ goes back to its place", async () => {
  const { history } = await openApp("/chats?market=bot/inbox");
  const market = await findMarket();
  expect(await within(market).findByRole("heading", { level: 1, name: "Inbox" })).toBeTruthy();
  expect(within(market).getByRole("navigation", { name: "Back" }).textContent).toContain("Bots");

  await press("{Meta>}[[{/Meta}");
  expect(await within(market).findByRole("region", { name: "From publishers" })).toBeTruthy();
  expect(new URLSearchParams(history.location.search).get("market")).toBe("bots");

  // A link followed while it's open lands where it points.
  act(() => history.push("/chats?market=suit/harbour-dusk"));
  expect(await screen.findByRole("heading", { level: 1, name: "Harbour dusk" })).toBeTruthy();

  // Closing takes it off the address.
  await expectClosesOnEscape(press);
  expect(new URLSearchParams(history.location.search).get("market")).toBeNull();
});
