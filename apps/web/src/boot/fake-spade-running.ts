import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * What the Running page shows in the fake world (ADR 0200 §6.3): spend and network for the bots
 * at work, a worker under Release notes, Garden's failure, Flights' next wake, and Daily and Ivy
 * paused with their next wakes held. The rest read from the roster as they are.
 */
export function seedFakeRunning(here: FakeSpadeApi, now: number): void {
  const hour = 3_600_000;
  const facts = here.running.facts;
  facts.set("spade", {
    uses: { answering: true },
    spend: { today_micros: 640_000, month_micros: 9_820_000, last_hour_micros: 120_000 },
    network: {
      sent_bytes: 48_000,
      received_bytes: 2_310_000,
      hosts: ["www.staybook.com", "maps.example.com"],
    },
  });
  facts.set("notes", {
    uses: { answering: true, jobs: 1 },
    spend: { today_micros: 310_000, month_micros: 2_040_000 },
    workers: [
      {
        id: "changelog",
        name: "Changelog",
        state: "working",
        doing: "Reading merged pull requests",
      },
    ],
  });
  facts.set("flights", {
    spend: { today_micros: 180_000, month_micros: 1_240_000 },
    network: { sent_bytes: 9_000, received_bytes: 412_000, hosts: ["api.fares.example"] },
    next_wake: { at_ms: now + 2 * hour, what: "Check Lisbon fares" },
  });
  facts.set("garden", { failure: "Codex is signed out. Sign in to it in ace." });
  // Daily is paused with a question still open, so it reads waiting; Ivy is simply paused.
  for (const [id, what] of [
    ["daily", "Today's lesson"],
    ["ivy", "Morning brief"],
  ] as const) {
    const agent = here.agents.find((each) => each.id === id);
    if (!agent) continue;
    here.running.pause(agent);
    facts.set(id, {
      spend: { month_micros: 420_000 },
      next_wake: { at_ms: now + 14 * hour, what },
    });
  }
}
