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

const profile = async () =>
  within(await screen.findByRole("region", { name: "Flights's profile" }));

test("an edit to a page the bot changed meanwhile is refused, says so, and the next save keeps it", async () => {
  let page = "";
  const { spade } = await spadeApp("/spade/flights?profile=library", (api) => {
    withFlights(api);
    page = api.knowledge.add({
      agent: "flights",
      title: "TAP fares",
      body: "TAP runs €212 return.",
      source: { kind: "bot", detail: "Find the cheapest flight" },
      author: { bot: "flights" },
    }).id;
  });
  const panel = await profile();
  await userEvent.click(await panel.findByRole("button", { name: /^TAP fares/ }));
  expect(
    await panel.findByText("Flights wrote it today · for Find the cheapest flight"),
  ).toBeTruthy();
  await userEvent.click(panel.getByRole("button", { name: "Edit" }));
  const field = await panel.findByRole("textbox", { name: "Page" });
  // The bot rewrites the page while the person types.
  spade.knowledge.rewrite(page, "TAP runs €224 return.");
  await userEvent.clear(field);
  await userEvent.type(field, "TAP runs €199 return.");
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  expect((await panel.findByRole("alert")).textContent).toMatch(/^Changed since you opened it/);
  expect(spade.knowledge.entries[0]?.body).toBe("TAP runs €224 return.");
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  await waitFor(() => expect(spade.knowledge.entries[0]?.body).toBe("TAP runs €199 return."));
  expect(await panel.findByText("TAP runs €199 return.")).toBeTruthy();
});

test("a page from the web names its address, reads untrusted, and Trust this trusts it", async () => {
  const { spade } = await spadeApp("/spade/flights?profile=library", (api) => {
    withFlights(api);
    api.knowledge.add({
      agent: "flights",
      title: "Cabin bags",
      body: "One small bag is free.",
      source: { kind: "web", detail: "https://www.ryanair.com/baggage" },
      trust: "untrusted",
      author: { bot: "flights" },
    });
  });
  const panel = await profile();
  await userEvent.click(await panel.findByRole("button", { name: /^Cabin bags/ }));
  expect(
    (await panel.findByRole("link", { name: "ryanair.com/baggage" })).getAttribute("href"),
  ).toBe("https://www.ryanair.com/baggage");
  expect(panel.getByText(/Untrusted/)).toBeTruthy();
  await userEvent.click(panel.getByRole("button", { name: "Trust this" }));
  await waitFor(() => expect(spade.knowledge.entries[0]?.trust).toBe("trusted"));
  await waitFor(() => expect(panel.queryByRole("button", { name: "Trust this" })).toBeNull());
  expect(panel.queryByText(/Untrusted/)).toBeNull();
});

test("one search finds notes, pages and past work, and leaves out groups with nothing", async () => {
  await spadeApp("/spade/flights?profile=library", (api) => {
    withFlights(api);
    api.notes.add({ text: "Prefers aisle seats", agent: "flights", scope: "agent" });
    api.notes.add({ text: "Home airport is OPO", agent: "flights", scope: "agent" });
    api.knowledge.add({ agent: "flights", title: "Booking rules", body: "An aisle seat is fine." });
    api.knowledge.addEpisode({ agent: "flights", title: "Hotel shortlist" });
  });
  const panel = await profile();
  await userEvent.type(await panel.findByRole("searchbox"), "aisle");
  const notes = within(await panel.findByRole("list", { name: "Notes" }));
  await waitFor(() =>
    expect(notes.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Prefers aisle seats",
    ]),
  );
  expect(
    within(panel.getByRole("list", { name: "Pages" })).getByText("Booking rules"),
  ).toBeTruthy();
  expect(panel.queryByRole("heading", { name: "Past work" })).toBeNull();
});

test("an empty Library says so in one line per section, and Add on a heading writes in place", async () => {
  const { spade } = await spadeApp("/spade/flights?profile=library", withFlights);
  const panel = await profile();
  const section = async (name: string) =>
    within((await panel.findByRole("heading", { name })).closest("section") as HTMLElement);
  const notes = await section("Notes");
  await notes.findByText("No notes yet.");
  const pages = await section("Pages");
  await pages.findByText("No pages yet.");
  expect(
    await (await section("Past work")).findByText("Each goal Flights finishes is kept here."),
  ).toBeTruthy();

  await userEvent.click(notes.getByRole("button", { name: "Add a note" }));
  expect(notes.queryByText("No notes yet.")).toBeNull();
  await userEvent.type(
    notes.getByRole("textbox", { name: "Add something for Flights to remember" }),
    "Flies from Porto{Enter}",
  );
  await notes.findByRole("button", { name: "Edit: Flies from Porto" });
  expect(spade.notes.notes.map((note) => note.text)).toEqual(["Flies from Porto"]);

  await userEvent.click(pages.getByRole("button", { name: "Add a page" }));
  expect(pages.queryByText("No pages yet.")).toBeNull();
  await userEvent.click(pages.getByRole("button", { name: "Cancel" }));
  expect(pages.getByText("No pages yet.")).toBeTruthy();
  expect(pages.queryByRole("textbox", { name: "Title" })).toBeNull();
});

test("Stop ends a running service in place, and a service that ended offers no Stop", async () => {
  const { spade } = await spadeApp("/spade/flights?profile=computer&computer=services", (api) => {
    withFlights(api);
    api.services.start("flights", { name: "fare watcher", command: "python fares.py --watch" });
    api.services.start("flights", {
      name: "alerts tail",
      command: "ssh fares tail -f alerts.log",
      state: "exited",
      exit_code: 255,
    });
  });
  const list = within(await (await profile()).findByRole("list", { name: "Flights's services" }));
  const row = (name: string) => within(list.getByText(name).closest("li") as HTMLElement);
  await waitFor(() => expect(row("alerts tail").getByText("Ended · exit 255")).toBeTruthy());
  expect(row("alerts tail").queryByRole("button", { name: "Stop" })).toBeNull();
  await userEvent.click(row("fare watcher").getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(row("fare watcher").getByText("Stopped")).toBeTruthy());
  expect(spade.services.byAgent.get("flights")?.[0]?.state).toBe("stopped");
});

test("a role following Settings says so until the person picks its model on the bot", async () => {
  const { spade } = await spadeApp("/spade/flights?profile=details", (api) => {
    withFlights(api);
    api.roles.spend.set("flights", { helper: 420_000 });
  });
  const panel = await profile();
  await userEvent.click(await panel.findByText("Models for other work"));
  const helpers = await panel.findByRole("button", { name: "Helpers" });
  const row = within(helpers.closest("[data-setting-slot]") as HTMLElement);
  expect(row.getByText("$0.42 this month")).toBeTruthy();
  expect(row.getByText("Follows Settings")).toBeTruthy();
  await userEvent.click(helpers);
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/flights/models")).toEqual([
      { roles: { helper: "openrouter/anthropic/sonnet" } },
    ]),
  );
  await waitFor(() => expect(row.queryByText("Follows Settings")).toBeNull());
});
