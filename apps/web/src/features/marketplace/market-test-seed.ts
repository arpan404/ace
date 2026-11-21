import type { MarketplaceSeed } from "@ace/fake-daemon";
import type { MarketEntrySummary, MarketReview, MarketReviewItem } from "@ace/protocol/marketplace";
import { createMemoryHistory } from "@tanstack/react-router";
import { screen } from "@testing-library/react";
import { harness } from "@/test/harness.tsx";
import type { SuitTransport } from "@/theme/suits/suit-transport.ts";

/*
 * The marketplace the modal's tests open: a Suit with its look in its review, a skill, a bot
 * recipe ace hasn't reviewed (one required app, one optional, a routine) and a withdrawn plugin.
 */

export const entry = (
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

/** Harbour dusk's suit.json, as its review's pages carry it. */
const harbourLook: MarketReviewItem[] = [
  {
    kind: "text",
    section: "",
    path: "suit.json",
    before: false,
    truncated: false,
    text: JSON.stringify({
      format: 1,
      id: "harbour-dusk",
      name: "Harbour dusk",
      dark: { canvas: "#101820", sidebar: "#0B1118", accent: "#E8B86A" },
    }),
  },
];

export const seed: MarketplaceSeed = {
  entries: [
    { summary: entry("suit", "harbour-dusk", "Harbour dusk"), items: harbourLook },
    { summary: entry("spade-skill", "triage-mail", "Triage mail") },
    { summary: entry("spade-bot", "inbox", "Inbox", { reviewed: false }), review: inboxRecipe },
    {
      summary: entry("spade-plugin", "old-tools", "Old tools"),
      withdrawn: "It sent files to a server it didn't name",
    },
  ],
  featured: [
    { type: "suit", name: "harbour-dusk" },
    { type: "spade-bot", name: "inbox" },
  ],
  categories: [{ id: "mail", title: "Mail" }],
};

/** The app at `path` over this marketplace. */
export async function openApp(
  path: string,
  more: MarketplaceSeed = {},
  options: { suits?: SuitTransport } = {},
) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = harness({ history, ...options });
  app.daemon.seedServices({ marketplace: { ...seed, ...more } });
  await app.open(path);
  return { daemon: app.daemon, history };
}

/**
 * The Marketplace's page, once it shows: the whole window, since its panel (search, the places,
 * Installed) and its page are both the Marketplace's.
 */
export async function findMarket(): Promise<HTMLElement> {
  await screen.findByRole("region", { name: "Marketplace" });
  return document.body;
}
