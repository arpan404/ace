import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`'s bot from an agent package (ADR 0200 §3.9): Fare watch, linked to Flight
 * watcher 2.0.0 (1.0.0 before it), its declared effects with the switches the person left. The
 * Marketplace's side, with 2.1.0 waiting, is `fake-market-packages.ts`.
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
    },
  });
}
