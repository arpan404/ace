import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const sha = "b".repeat(64);

/** A card in every block kind ace draws, plus one a later Spade adds. */
const fareDrop = (title: string) => ({
  title,
  blocks: [
    { kind: "metric", label: "Fare", value: "182", unit: "USD", change: "-24" },
    { kind: "fields", rows: [{ label: "Dates", value: "12-19 Jan" }] },
    { kind: "progress", label: "Trips checked", value: 3, max: 5 },
    { kind: "table", columns: ["Carrier", "Fare"], rows: [["Buddha Air", "199"]] },
    { kind: "list", items: ["Morning flight", "One bag"], ordered: true },
    {
      kind: "image",
      file: "charts/fares.png",
      image: { sha256: sha, media_type: "image/png", bytes: 10 },
      alt: "Fares this week",
    },
    {
      kind: "link",
      url: "https://fares.example.com/ktm-del",
      host: "fares.example.com",
      label: "The fare",
    },
    { kind: "chart", series: [1, 2, 3] },
    {
      kind: "actions",
      actions: [
        { kind: "choose", id: "keep", label: "Keep watching" },
        { kind: "choose", id: "stop", label: "Stop watching" },
        {
          kind: "open",
          label: "Book it",
          url: "https://air.example.com/book",
          host: "air.example.com",
        },
      ],
    },
  ],
});

function watcher(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const bot = api.addAgent({ id: "watcher", name: "Flight watcher" });
  api.showCard(bot, "card_1", 1, fareDrop("Fare dropped: <b>KTM</b> to DEL"));
}

const theCard = async (title = "Fare dropped: <b>KTM</b> to DEL") =>
  within(
    await within(
      await screen.findByRole("feed", { name: "Conversation with Flight watcher" }),
    ).findByRole("region", { name: `Flight watcher: ${title}` }),
  );

test("every block kind is drawn by ace from the card's data, and a bot's markup stays text", async () => {
  await spadeApp("/spade/watcher", watcher);
  const card = await theCard();
  expect(card.getByRole("heading", { name: "Fare dropped: <b>KTM</b> to DEL" })).toBeTruthy();
  expect(card.queryByText("KTM", { selector: "b" })).toBeNull();
  expect(card.getByText("182")).toBeTruthy();
  expect(card.getByText("USD")).toBeTruthy();
  expect(card.getByText("Dates")).toBeTruthy();
  expect(card.getByText("12-19 Jan")).toBeTruthy();
  expect(
    card.getByRole("progressbar", { name: "Trips checked" }).getAttribute("aria-valuetext"),
  ).toBe("3 of 5");
  expect(card.getByRole("columnheader", { name: "Carrier" })).toBeTruthy();
  expect(card.getByRole("cell", { name: "Buddha Air" })).toBeTruthy();
  expect(card.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Morning flight",
    "One bag",
  ]);
  expect(card.getByRole("figure", { name: "Fares this week" })).toBeTruthy();
  // A link shows where it goes; an open action names its host before it is pressed.
  const link = card.getByRole("link", { name: /The fare/ });
  expect(link.textContent).toBe("The fare · fares.example.com");
  expect(link.getAttribute("href")).toBe("https://fares.example.com/ktm-del");
  const book = card.getByRole("link", { name: /Book it/ });
  expect(book.textContent).toContain("air.example.com");
  expect(book.getAttribute("href")).toBe("https://air.example.com/book");
  expect(book.getAttribute("rel")).toContain("noopener");
  // The block a later Spade draws is left out; nothing of it shows.
  expect(card.queryByText(/series/)).toBeNull();
});

test("a choice is sent once, on the version shown, and the card then says what was chosen", async () => {
  const { spade } = await spadeApp("/spade/watcher", watcher);
  const card = await theCard();
  await userEvent.click(card.getByRole("button", { name: "Keep watching" }));
  expect(await card.findByText("Keep watching", { selector: "span" })).toBeTruthy();
  expect(card.getByText(/You chose/)).toBeTruthy();
  expect(card.queryByRole("button", { name: "Stop watching" })).toBeNull();
  expect(spade.sent("POST", "/v1/conversations/c-watcher/cards/card_1/actions")).toEqual([
    { action: "keep", version: 1 },
  ]);
});

test("a later version replaces the card in place and opens its choices again", async () => {
  const { spade } = await spadeApp("/spade/watcher", watcher);
  await theCard();
  const bot = spade.agents.find((agent) => agent.id === "watcher");
  if (!bot) throw new Error("no bot");
  spade.showCard(bot, "card_1", 2, fareDrop("Fare now 170"));
  const card = await theCard("Fare now 170");
  const feed = within(screen.getByRole("feed", { name: "Conversation with Flight watcher" }));
  await waitFor(() => expect(feed.queryByRole("region", { name: /Fare dropped/ })).toBeNull());
  await userEvent.click(card.getByRole("button", { name: "Stop watching" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-watcher/cards/card_1/actions")).toEqual([
      { action: "stop", version: 2 },
    ]),
  );
});
