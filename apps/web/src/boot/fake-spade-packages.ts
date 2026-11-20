import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`'s bots from agent packages (ADR 0200 §3.9): Fare watch, linked to Flight
 * watcher 2.0.0 (1.0.0 before it), its declared effects with the switches the person left; and
 * Ship notes, a development bot of a package folder (§9). The Marketplace's side, with 2.1.0
 * waiting, is `fake-market-packages.ts`.
 */
export function seedFakePackages(here: FakeSpadeApi, now: number): void {
  here.addAgent({
    id: "fare-watch",
    name: "Fare watch",
    task: "Watch fares to Lisbon and Porto for May. Tell me only about a real drop.",
    model: "openrouter/openai/gpt-6.1-mini",
    style: { accent: "#0f8a8a", chosen: false },
    avatar: {
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
    last_activity: now - 3 * 60 * 60_000,
    package: {
      source: "market",
      name: "flight-watcher",
      version: "2.0.0",
      hash: "c".repeat(64),
      previous: { version: "1.0.0", hash: "d".repeat(64) },
      withdrawn: null,
      updating: null,
      effects: [
        {
          key: "network:hosts:api.example-fares.com",
          effect: "network",
          hosts: ["api.example-fares.com"],
          why: "Reads fares.",
          on: true,
        },
        {
          key: "network:drive_site:book.example-air.com",
          effect: "network",
          hosts: [],
          grant: { kind: "drive_site", host: "book.example-air.com" },
          why: "Opens a fare's page to check the price still holds.",
          on: false,
        },
        {
          key: "send_as_person",
          effect: "send_as_person",
          hosts: [],
          why: "Drafts a mail to your travel agent. You send it.",
          on: false,
        },
      ],
      // What the person's other bots may ask it (ADR 0200 §7); Trip planner does.
      contracts: [
        {
          name: "cheapest_fare",
          summary: "The cheapest fare seen for a route this week.",
          effects: ["network"],
        },
        {
          name: "watched_trips",
          summary: "The trips it watches, with the most you'd pay for each.",
          effects: [],
        },
      ],
    },
  });
  // A development bot (ADR 0200 §9): linked to a package folder `ace bot dev` keeps it updated from.
  here.addAgent({
    id: "ship-notes",
    name: "Ship notes",
    task: "Write the week's release notes from merged changes every Friday.",
    model: "openrouter/openai/gpt-6.1-mini",
    avatar: {
      kind: "character",
      v: 1,
      body: "pebble",
      pair: "sage",
      ears: "bear",
      marking: "none",
      eyes: "sleepy",
      mouth: "smile",
      cheeks: "none",
      accessory: "none",
    },
    last_activity: now - 60_000,
    package: {
      source: "local",
      name: "local/ship-notes",
      version: "local",
      hash: "e".repeat(64),
      previous: null,
      withdrawn: null,
      updating: null,
      effects: [],
    },
  });
}
