import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`'s kept tests (ADR 0204 §1): Fare watch has two of its runs kept, one marked
 * wrong with why, one from its morning routine marked right. Its profile lists them; any of its
 * finished replies offers Keep as a test from the bubble's More menu.
 */
export function seedFakeCases(here: FakeSpadeApi, now: number): void {
  if (!here.agents.some((agent) => agent.id === "fare-watch")) return;
  here.cases.add("fare-watch", {
    reply: "r-fares-morning",
    trigger: { kind: "routine", name: "Morning fares" },
    given: { messages: ["Check the Porto to Lisbon fares for May."] },
    outcome: { text: "Cheapest is 39 EUR on 14 May, direct, at 07:10." },
    mark: "right",
    made_at: now - 26 * 60 * 60_000,
  });
  here.cases.add("fare-watch", {
    reply: "r-fares-stopover",
    given: { messages: ["Find me the cheapest way to Lisbon on Friday."] },
    outcome: { text: "The cheapest is 31 EUR with a stop in Madrid." },
    mark: "wrong",
    why: "I asked for direct flights only",
    made_at: now - 40 * 60_000,
  });
}
