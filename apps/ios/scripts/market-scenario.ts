import type { FakeDaemon } from "@ace/fake-daemon";
import type {
  MarketEntrySummary,
  MarketInstalled,
  MarketPublisherPage,
} from "@ace/protocol/marketplace";

/*
 * The Marketplace for the phone's screens: a bot, skill, plugin and Suit each from ace and from
 * a verified publisher, a hero, Trending, New and a collection, two categories, one install
 * waiting on an update and one its publisher withdrew. No market or network is reached.
 */

const day = 24 * 60 * 60 * 1000;
const harbour = { id: "pub-harbour", name: "harbour-co" };
const ace = { id: "pub-ace", name: "ace" };

export function marketScenario(now: number) {
  const listing = (
    type: string,
    name: string,
    title: string,
    line: string,
    extra: Partial<MarketEntrySummary>,
  ): MarketEntrySummary => ({
    source: "market",
    type,
    name,
    title,
    line,
    categories: ["mail"],
    keywords: [],
    version: "1.0.0",
    reviewed: true,
    byAce: false,
    updated: now - 3 * day,
    downloads: 120,
    supported: true,
    ...extra,
  });
  const byAce = { byAce: true, publisher: ace, verified: true };
  const fromHarbour = { publisher: harbour, verified: true };
  const entries = {
    inbox: listing("spade-bot", "inbox", "Inbox", "Sorts your mail every morning.", {
      ...byAce,
      downloads: 4_210,
      updated: now - day,
    }),
    standup: listing(
      "spade-bot",
      "standup-notes",
      "Standup notes",
      "Writes the team's daily notes.",
      {
        ...fromHarbour,
        categories: ["work"],
        downloads: 860,
      },
    ),
    triage: listing("spade-skill", "triage-mail", "Triage mail", "Labels and files new mail.", {
      ...byAce,
      version: "1.2.0",
      downloads: 2_980,
    }),
    receipts: listing(
      "spade-skill",
      "receipt-filer",
      "Receipt filer",
      "Files receipts as they arrive.",
      {
        ...fromHarbour,
        updated: now - 2 * 60 * 60 * 1000,
        downloads: 75,
      },
    ),
    calendar: listing(
      "spade-plugin",
      "calendar-tools",
      "Calendar tools",
      "Reads and books meetings.",
      {
        ...byAce,
        categories: ["work"],
        downloads: 1_540,
      },
    ),
    tracker: listing(
      "spade-plugin",
      "issue-tracker",
      "Issue tracker",
      "Opens and updates issues.",
      {
        ...fromHarbour,
        categories: ["work"],
        reviewed: false,
        downloads: 310,
      },
    ),
    graphite: listing("suit", "graphite", "Graphite", "A quiet grey look for long days.", {
      ...byAce,
      categories: ["work"],
      downloads: 3_400,
    }),
    dusk: listing("suit", "harbour-dusk", "Harbour dusk", "Warm evening colours.", {
      ...fromHarbour,
      updated: now - 6 * 60 * 60 * 1000,
      downloads: 980,
    }),
  };
  const all = Object.values(entries);
  const installed: MarketInstalled[] = [
    {
      source: "market",
      type: "spade-skill",
      name: "triage-mail",
      title: "Triage mail",
      version: "1.0.0",
      hash: "a".repeat(64),
      acceptedAt: now - 20 * day,
      state: "on",
      update: "1.2.0",
      botsApproved: true,
    },
    {
      source: "market",
      type: "spade-plugin",
      name: "old-sorter",
      title: "Old sorter",
      version: "0.3.0",
      hash: "b".repeat(64),
      acceptedAt: now - 60 * day,
      state: "withdrawn",
      reason: "Replaced by Triage mail.",
    },
  ];
  const harbourPage: MarketPublisherPage = {
    profile: {
      id: harbour.id,
      handle: harbour.name,
      displayName: "Harbour Co",
      bio: "Small tools and looks for people who work from their inbox.",
      links: [{ label: "Site", url: "https://harbour.example" }],
      joined: now - 400 * day,
      verified: true,
      proofs: [{ kind: "domain", domain: "harbour.example", via: "dns" }],
      pins: [{ type: "suit", name: "harbour-dusk" }],
    },
    pinned: [entries.dusk],
    entries: [entries.dusk, entries.standup, entries.receipts, entries.tracker],
    downloads: 2_225,
  };
  return {
    entries: all.map((summary) => ({ summary, description: `${summary.title}. ${summary.line}` })),
    featured: [entries.inbox, entries.graphite, entries.calendar].map(({ type, name }) => ({
      type,
      name,
    })),
    categories: [
      { id: "mail", title: "Mail" },
      { id: "work", title: "Work" },
    ],
    installed,
    publishing: {
      discover: {
        hero: entries.inbox,
        featured: [entries.inbox, entries.graphite, entries.calendar, entries.dusk],
        trending: [entries.triage, entries.inbox, entries.dusk, entries.standup].map(
          (entry, index) => ({
            entry,
            rank: index + 1,
            movement:
              index === 0
                ? ({ kind: "up", by: 2 } as const)
                : index === 2
                  ? ({ kind: "new" } as const)
                  : ({ kind: "same" } as const),
            week: entry.downloads,
          }),
        ),
        fresh: [entries.receipts, entries.dusk, entries.inbox],
        collections: [
          {
            id: "inbox-zero",
            title: "Inbox zero",
            line: "Everything you need to get mail off your plate.",
            entries: [entries.inbox, entries.triage, entries.receipts],
          },
        ],
        publishers: [
          {
            handle: ace.name,
            displayName: "ace",
            verified: true,
            official: true,
            entries: 4,
            downloads: 12_130,
          },
          {
            handle: harbour.name,
            displayName: "Harbour Co",
            verified: true,
            entries: 4,
            downloads: 2_225,
          },
        ],
        rankedAt: now,
      },
      publishers: [harbourPage],
    },
  };
}

export function seedMarket(daemon: FakeDaemon, now: number): void {
  daemon.seedServices({ marketplace: marketScenario(now) });
}
