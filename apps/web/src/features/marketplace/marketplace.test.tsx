import type { FakeDaemon, MarketplaceSeed } from "@ace/fake-daemon";
import type { MarketEntrySummary, MarketReview } from "@ace/protocol/marketplace";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openPanelSearch } from "@/test/panel-search.ts";
import { roster, spadeApp } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

const entry = (
  type: string,
  name: string,
  title: string,
  extra: Partial<MarketEntrySummary> = {},
): MarketEntrySummary => ({
  source: "market",
  type,
  name,
  title,
  line: `${title} in one line`,
  publisher: { id: "pub-1", name: "harbour-co" },
  categories: ["mail"],
  keywords: [],
  version: "1.0.0",
  reviewed: true,
  byAce: false,
  updated: 1,
  downloads: 3,
  supported: true,
  ...extra,
});

/** A recipe whose bot needs mail (required) and a receipts server (optional), with one routine. */
const inboxRecipe: Partial<MarketReview> = {
  body: {
    type: "spade-bot",
    botName: "Inbox",
    task: "You look after the person's inbox.",
    model: "fast",
    routines: [
      { name: "Morning sort", instruction: "Sort the inbox.", schedule: "weekdays at 8:00" },
    ],
    notes: [],
    brings: [],
    needs: [
      {
        key: "connector:gmail",
        kind: "connector",
        label: "Gmail",
        why: "Reads mail.",
        required: true,
      },
      {
        key: "connector:https://receipts.example/mcp",
        kind: "connector",
        label: "Receipts",
        why: "Files receipts.",
        required: false,
      },
    ],
    spadeReady: true,
  },
};

const seed: MarketplaceSeed = {
  entries: [
    { summary: entry("suit", "harbour-dusk", "Harbour dusk") },
    { summary: entry("spade-skill", "triage-mail", "Triage mail") },
    { summary: entry("spade-bot", "inbox", "Inbox", { reviewed: false }), review: inboxRecipe },
    {
      summary: entry("spade-plugin", "old-tools", "Old tools"),
      withdrawn: "It sent files to a server it didn't name",
    },
  ],
  featured: [
    { type: "suit", name: "harbour-dusk" },
    { type: "spade-skill", name: "triage-mail" },
  ],
  categories: [{ id: "mail", title: "Mail" }],
};

async function open(path: string, more: MarketplaceSeed = {}) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = harness({ history });
  app.daemon.seedServices({ marketplace: { ...seed, ...more } });
  await app.open(path);
  return { daemon: app.daemon, history };
}

const go = (history: RouterHistory, path: string) => act(() => history.push(path));

const results = () => within(screen.getByRole("list", { name: "Results" }));

async function installed(daemon: FakeDaemon) {
  return daemon.marketplace.handle({
    type: "marketplace.request",
    requestId: "check",
    operation: { op: "installed" },
  });
}

test("searching the panel narrows the entries to what matches", async () => {
  await open("/marketplace");
  expect(await screen.findByRole("heading", { name: "Featured" })).toBeTruthy();

  await userEvent.type(await openPanelSearch("Search marketplace"), "harbour");

  await screen.findByRole("list", { name: "Results" });
  await waitFor(() => expect(results().queryByText("Triage mail")).toBeNull());
  expect(results().getByText("Harbour dusk")).toBeTruthy();
});

test("an entry ace hasn't reviewed says so on its page", async () => {
  const { history } = await open("/marketplace/market/spade-bot/inbox");

  expect(await screen.findByRole("heading", { name: "Inbox" })).toBeTruthy();
  expect(screen.getByText("Not reviewed by ace")).toBeTruthy();
  // A reviewed one doesn't.
  go(history, "/marketplace/market/suit/harbour-dusk");
  await screen.findByRole("heading", { name: "Harbour dusk" });
  expect(screen.queryByText("Not reviewed by ace")).toBeNull();
});

test("a recipe installs with its switches as the person set them, then opens its bot", async () => {
  const { app, spade } = await spadeApp("/marketplace/market/spade-bot/inbox/review", () => {}, {
    daemon: (daemon) => {
      daemon.seedServices({ marketplace: seed });
      daemon.marketplace.makeBot = () => spade.addAgent({ id: "inbox-bot", name: "Inbox" }).id;
    },
  });

  // Required needs start on, optional ones off, and the routines paused.
  const gmail = await screen.findByRole("switch", { name: "Gmail" });
  const receipts = screen.getByRole("switch", { name: "Receipts" });
  const routines = screen.getByRole("switch", { name: "Start its routines" });
  expect(gmail.getAttribute("aria-checked")).toBe("true");
  expect(receipts.getAttribute("aria-checked")).toBe("false");
  expect(routines.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(gmail);
  await userEvent.click(receipts);
  await userEvent.click(routines);
  await userEvent.click(screen.getByRole("button", { name: "Install" }));

  expect(await (await roster()).findByText("Inbox")).toBeTruthy();
  expect(app.daemon.marketplace.accepted.map((accepted) => accepted.choices)).toEqual([
    {
      bots: [],
      needs: { "connector:gmail": false, "connector:https://receipts.example/mcp": true },
      startRoutines: true,
    },
  ]);
});

test("a withdrawn entry says why and can't be installed", async () => {
  const app = await open("/marketplace/market/spade-plugin/old-tools");

  expect(
    await screen.findByText(
      "Withdrawn by its publisher: It sent files to a server it didn't name.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Install" })).toBeNull();

  // Its review address refuses too, with no Install to press.
  go(app.history, "/marketplace/market/spade-plugin/old-tools/review");
  await screen.findByRole("heading", { name: "Review Old tools" });
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  expect(app.daemon.marketplace.accepted).toEqual([]);
});

test("an update waits in Updates until its own review is installed", async () => {
  const app = await open("/marketplace/updates", {
    entries: [
      ...(seed.entries ?? []),
      { summary: entry("spade-skill", "triage-mail", "Triage mail", { version: "1.1.0" }) },
    ],
    installed: [
      {
        source: "market",
        type: "spade-skill",
        name: "triage-mail",
        title: "Triage mail",
        version: "1.0.0",
        hash: "a".repeat(64),
        acceptedAt: 1,
        state: "on",
        update: "1.1.0",
      },
    ],
  });

  const updates = within(await screen.findByRole("list", { name: "Updates" }));
  expect(updates.getByText(/1\.1\.0 available/)).toBeTruthy();
  // Nothing applied on its own.
  expect(await installed(app.daemon)).toMatchObject({
    result: { installed: [{ name: "triage-mail", version: "1.0.0" }] },
  });

  await userEvent.click(updates.getByRole("link", { name: "Review update" }));
  expect(
    await screen.findByText("Replaces version 1.0.0, which stays until you install."),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Install" }));

  await waitFor(async () =>
    expect(await installed(app.daemon)).toMatchObject({
      result: { installed: [{ name: "triage-mail", version: "1.1.0" }] },
    }),
  );
  go(app.history, "/marketplace/updates");
  expect(await screen.findByText("Everything is up to date.")).toBeTruthy();
});
