import type { FakeMarketEntry } from "@ace/fake-daemon";
import type { MarketInstalled, MarketReview, MarketReviewBody } from "@ace/protocol/marketplace";

/*
 * `?fakeWorld=spade`'s agent package (ADR 0200): Flight watcher, a version 3 package installed
 * as Spade's Fare watch, at 2.0.0 with 2.1.0 waiting. Its install review shows its effects as
 * switches; its update review says what stays because the person changed the task; its
 * rollback goes back to 1.0.0 from the copy kept on this machine.
 */

const publisher = { id: "pub_harbour", name: "harbour" };

const body: Extract<MarketReviewBody, { type: "spade-bot" }> = {
  type: "spade-bot",
  botName: "Flight watcher",
  face: {
    kind: "character",
    v: 1,
    body: "round",
    pair: "lagoon",
    ears: "none",
    marking: "none",
    eyes: "egg",
    mouth: "smile",
    cheeks: "none",
    accessory: "none",
  },
  task: "You watch flight fares for the person. For each trip they name, keep the route, the dates and the most they'd pay. Tell them only about a real drop, with the fare and the link. Never book or pay.",
  model: "fast",
  routines: [
    {
      name: "Morning check",
      instruction: "Check every watched trip. Tell me only about drops.",
      schedule: "daily at 7:00",
    },
  ],
  notes: ["The person books. Never press a purchase button."],
  brings: [],
  needs: [],
  spadeReady: true,
  linked: true,
  effects: [
    {
      key: "network:hosts:api.example-fares.com",
      effect: "network",
      hosts: ["api.example-fares.com"],
      why: "Reads fares.",
    },
    {
      key: "network:drive_site:book.example-air.com",
      effect: "network",
      grant: { kind: "drive_site", host: "book.example-air.com" },
      why: "Opens a fare's page to check the price still holds.",
    },
    {
      key: "send_as_person",
      effect: "send_as_person",
      why: "Drafts a mail to your travel agent. You send it.",
    },
  ],
  triggers: [
    { kind: "message" },
    { kind: "webhook", name: "Fare feed", instruction: "Read the posted fare." },
    { kind: "mention", in: ["threads", "clubs"] },
  ],
  limits: { spend_alert: { usd_per_day: 0.5 }, workers_at_once: 2 },
};

const install: Partial<MarketReview> = { version: "2.1.0", publisher, body };

const update: Partial<MarketReview> = {
  version: "2.1.0",
  updates: "2.0.0",
  body: {
    ...body,
    effects: [
      ...(body.effects ?? []),
      { key: "publish", effect: "publish", why: "Posts a weekly fare report to your blog." },
    ],
    update: {
      bot: "fare-watch",
      rollback: false,
      plan: {
        name: "same",
        task: "kept",
        face: "same",
        personality: "replace",
        routines: [
          { step: "replace", name: "Morning check" },
          { step: "add", name: "Evening check" },
        ],
        notes_kept: 0,
        asks_more: ["publish"],
        off: [],
      },
      asksMore: [],
      // Fare watch's two kept runs (`fake-spade-cases.ts`), replayed free on 2.1.0 (ADR 0204 §2).
      replay: {
        summary: "1 of 2 kept runs replay the same. 1 doesn't: see why.",
        passed: 1,
        failed: 1,
        cases: [
          {
            id: "case_1",
            given: "Find me the cheapest way to Lisbon on Friday.",
            passed: false,
            lines: [
              "card_show answered an error: Not shown: the fare-drop card doesn't pass the package's checks: fare-has-link: data.link: is missing",
            ],
          },
          {
            id: "case_2",
            given: "Check the Porto to Lisbon fares for May.",
            passed: true,
            lines: [],
          },
        ],
      },
    },
  },
};

const rollback: Partial<MarketReview> = {
  version: "1.0.0",
  updates: "2.0.0",
  body: {
    ...body,
    update: {
      bot: "fare-watch",
      rollback: true,
      plan: {
        name: "same",
        task: "kept",
        face: "same",
        personality: "same",
        routines: [{ step: "remove", name: "Fare feed" }],
        notes_kept: 0,
        asks_more: [],
        off: ["network:drive_site:book.example-air.com"],
      },
      asksMore: [],
    },
  },
};

export function packageEntries(now: number): FakeMarketEntry[] {
  return [
    {
      summary: {
        source: "market",
        type: "spade-bot",
        name: "flight-watcher",
        title: "Flight watcher",
        line: "Watches fares for the trips you name and tells you when one drops.",
        publisher,
        categories: ["travel"],
        keywords: [],
        version: "2.1.0",
        reviewed: true,
        byAce: false,
        verified: true,
        updated: now - 2 * 86_400_000,
        downloads: 212,
        supported: true,
      },
      review: install,
      updateReview: update,
      rollbackReview: rollback,
    },
  ];
}

export function packageInstalls(now: number): MarketInstalled[] {
  return [
    {
      source: "market",
      type: "spade-bot",
      name: "flight-watcher",
      title: "Flight watcher",
      version: "2.0.0",
      hash: "c".repeat(64),
      acceptedAt: now - 3 * 86_400_000,
      state: "on",
      target: "fare-watch",
      linked: true,
      update: "2.1.0",
      previous: { version: "1.0.0", hash: "d".repeat(64) },
    },
  ];
}
