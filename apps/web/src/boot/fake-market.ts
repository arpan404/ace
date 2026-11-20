import { marketPickFixture, marketPublishFixture, type MarketplaceSeed } from "@ace/fake-daemon";
import { packageEntries, packageInstalls } from "./fake-market-packages.ts";
import type {
  MarketDiscover,
  MarketEntrySummary,
  MarketPublisherPage,
} from "@ace/protocol/marketplace";

/*
 * The fake app's marketplace: the entries market.acehq.dev lists, by ace, beside a third-party
 * publisher's Suits, skill and plugin, with the publishing fixture's own account, drafts and
 * publisher pages. Discover is built from these listings, so every card opens an entry.
 */

const ace = { id: "pub_ace", name: "ace" };
const harbour = { id: "pub_harbour", name: "harbour" };

type Listing = [type: string, name: string, title: string, line: string, categories: string[]];

const byAce: Listing[] = [
  ["spade-bot", "finance", "Finance", "Watches spending, bills and subscriptions.", ["money"]],
  [
    "spade-bot",
    "health-habits",
    "Health habits",
    "Keeps you on track with the habits you choose.",
    ["health"],
  ],
  ["spade-bot", "inbox", "Inbox", "Sorts what came in and tells you what needs you.", ["mail"]],
  [
    "spade-bot",
    "learning",
    "Learning",
    "Teaches a topic step by step and checks you understood.",
    ["learning"],
  ],
  [
    "spade-bot",
    "meeting-notes",
    "Meeting notes",
    "Prepares meetings and keeps the follow-ups.",
    ["meetings"],
  ],
  [
    "spade-bot",
    "on-call",
    "On-call",
    "Looks at alerts and errors and says what matters.",
    ["engineering"],
  ],
  [
    "spade-bot",
    "release-notes",
    "Release notes",
    "Turns merged work into clear release notes.",
    ["engineering", "writing"],
  ],
  [
    "spade-bot",
    "research",
    "Research",
    "Finds and checks sources, then answers with citations.",
    ["research"],
  ],
  [
    "spade-bot",
    "travel",
    "Travel",
    "Plans trips and keeps the details straight.",
    ["travel", "planning"],
  ],
  ["spade-bot", "writing", "Writing", "Drafts, edits and tightens your writing.", ["writing"]],
  [
    "spade-skill",
    "inbox-triage",
    "Inbox triage",
    "Sorts what came in by what needs you today, and drafts replies to approve.",
    ["mail"],
  ],
  [
    "spade-skill",
    "meeting-minutes",
    "Meeting minutes",
    "Decisions, actions with owners and dates, and open questions from any meeting.",
    ["meetings", "writing"],
  ],
  [
    "spade-skill",
    "plain-writing",
    "Plain writing",
    "Tightens a draft into plain, specific prose without losing the writer's voice.",
    ["writing"],
  ],
  [
    "spade-skill",
    "research-brief",
    "Research brief",
    "Answers a question from primary sources, citing each claim.",
    ["research"],
  ],
  [
    "spade-skill",
    "weekly-review",
    "Weekly review",
    "What got done, what's open and what's next, in a two-minute read.",
    ["planning"],
  ],
  [
    "suit",
    "mizzle",
    "Mizzle",
    "Rain on a window over a city out of focus, in slate and lamplight.",
    ["calm", "dark"],
  ],
  [
    "suit",
    "tarn",
    "Tarn",
    "A mountain lake at blue hour behind cool slate panels.",
    ["calm", "dark"],
  ],
];

const byHarbour: Listing[] = [
  ["suit", "harbour-dusk", "Harbour dusk", "Warm lamps over a dark harbour.", ["calm", "dark"]],
  ["spade-skill", "triage-mail", "Triage mail", "Sorts mail into what needs you.", ["mail"]],
  [
    "spade-plugin",
    "mail-tools",
    "Mail tools",
    "Reads, labels and files mail for a bot through your own mail account.",
    ["mail"],
  ],
];

const day = 86_400_000;

function summary(
  [type, name, title, line, categories]: Listing,
  publisher: MarketEntrySummary["publisher"],
  index: number,
  now: number,
): MarketEntrySummary {
  return {
    source: "market",
    type,
    name,
    title,
    line,
    publisher,
    categories,
    keywords: [],
    version: "1.0.0",
    reviewed: publisher === ace,
    byAce: publisher === ace,
    verified: true,
    updated: now - index * day,
    downloads: 40 + ((index * 37) % 300),
    supported: true,
  };
}

export function fakeMarket(now: number): MarketplaceSeed {
  const listed = [
    ...byAce.map((listing, index) => summary(listing, ace, index, now)),
    ...byHarbour.map((listing, index) => summary(listing, harbour, index + 3, now)),
  ];
  const find = (name: string) => listed.filter((entry) => entry.name === name);
  const picks = ["mizzle", "inbox", "research", "meeting-notes", "tarn"].flatMap(find);
  // Discover as market.acehq.dev answers it: nothing trending yet, every entry new.
  const discover = {
    hero: find("mizzle")[0],
    featured: picks,
    trending: [],
    fresh: listed.toSorted((a, b) => b.updated - a.updated),
    collections: [],
    publishers: [
      {
        handle: "ace",
        displayName: "ace",
        verified: true,
        official: true,
        entries: byAce.length,
        downloads: 900,
      },
      {
        handle: "harbour",
        displayName: "Harbour Studio",
        verified: true,
        entries: 3,
        downloads: 480,
      },
    ],
    rankedAt: now,
  };
  return {
    entries: [...listed.map((entry) => ({ summary: entry })), ...packageEntries(now)],
    featured: picks.map(({ type, name }) => ({ type, name })),
    categories: [
      { id: "mail", title: "Mail" },
      { id: "writing", title: "Writing" },
      { id: "research", title: "Research" },
      { id: "meetings", title: "Meetings" },
      { id: "planning", title: "Planning" },
      { id: "engineering", title: "Engineering" },
      { id: "money", title: "Money" },
      { id: "health", title: "Health" },
      { id: "learning", title: "Learning" },
      { id: "travel", title: "Travel" },
      { id: "calm", title: "Calm" },
      { id: "dark", title: "Dark" },
    ],
    installed: [
      {
        source: "market",
        type: "spade-skill",
        name: "plain-writing",
        title: "Plain writing",
        version: "0.9.0",
        hash: "a".repeat(64),
        acceptedAt: now - 9 * day,
        state: "on",
        update: "1.0.0",
      },
      ...packageInstalls(now),
    ],
    publishing: publishing(discover, listed),
    pick: marketPickFixture(),
  };
}

/** The publishing fixture with the official publisher's own page, as the signed list marks it. */
function publishing(discover: Omit<MarketDiscover, "readAt">, listed: MarketEntrySummary[]) {
  const fixture = marketPublishFixture();
  const entries = listed.filter((entry) => entry.byAce);
  const page: MarketPublisherPage = {
    profile: {
      id: ace.id,
      handle: ace.name,
      displayName: "ace",
      bio: "The bots, Suits and skills the ace team makes and reviews.",
      links: [{ label: "Site", url: "https://acehq.dev" }],
      joined: 1_680_000_000_000,
      verified: true,
      official: true,
      proofs: [{ kind: "account" }],
      pins: [],
    },
    pinned: [],
    entries,
    downloads: 900,
    official: true,
  };
  return { ...fixture, discover, publishers: [...(fixture.publishers ?? []), page] };
}
