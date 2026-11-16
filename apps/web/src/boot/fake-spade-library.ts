import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * Flights' Library, services and model roles for `?fakeWorld=spade`: pages it wrote from its
 * own work and from the web (one untrusted), one the person wrote, two pages alike enough to
 * merge, its past work, services running and ended, and what its roles spent this month.
 */
export function seedFakeLibrary(spade: FakeSpadeApi, now: number) {
  const days = (count: number) => now - count * 86_400_000;
  const { knowledge } = spade;
  knowledge.add({
    agent: "flights",
    topic: "lessons",
    title: "Lessons",
    body: "Check fares in the morning; TAP drops prices before 9 AM.\n\nAsk before holding a seat: holds cost €5.",
    kind: "finding",
    source: { kind: "bot", detail: "Check fares every morning" },
    author: { bot: "flights" },
    created_at: days(4),
    updated_at: now - 40 * 60_000,
  });
  const tap = knowledge.add({
    agent: "flights",
    topic: "fares/tap",
    title: "TAP fares to Lisbon",
    body: "OPO to LIS on TAP runs €212–€239 return for the 14th to the 18th.\n\n- The 07:40 TP1351 is the cheapest.\n- Prices rose €12 on the evening of the 11th.",
    kind: "finding",
    source: { kind: "bot", detail: "Find the cheapest morning flight" },
    author: { bot: "flights" },
    created_at: days(3),
    updated_at: now - 3 * 60_000,
  });
  const tapAgain = knowledge.add({
    agent: "flights",
    topic: "fares/tap",
    title: "TAP morning flights",
    body: "TAP's 07:40 flight from Porto is usually the cheapest of the day.",
    kind: "fact",
    source: { kind: "bot", detail: null },
    author: { bot: "flights" },
    created_at: days(5),
    updated_at: days(5),
  });
  knowledge.merges.push({ a: tap.id, b: tapAgain.id, overlap: 0.72 });
  knowledge.add({
    agent: "flights",
    topic: "baggage",
    title: "Ryanair cabin bags",
    body: "One small bag under the seat is free. A 10 kg cabin bag costs from €6 and must be added before check-in.",
    kind: "howto",
    source: { kind: "web", detail: "https://www.ryanair.com/gb/en/useful-info/baggage" },
    trust: "untrusted",
    author: { bot: "flights" },
    created_at: days(2),
    updated_at: days(2),
  });
  knowledge.add({
    agent: "flights",
    topic: "preferences",
    title: "Booking rules",
    body: "Never book without asking. Window or aisle is fine; no middle seats.",
    created_at: days(6),
    updated_at: days(6),
  });

  knowledge.addEpisode({
    agent: "flights",
    title: "Found the cheapest morning flight to Lisbon",
    outcome: "verified",
    cost_micros: 140_000,
    started_at: now - 5 * 3_600_000,
    closed_at: now - 4 * 3_600_000,
    episode: {
      text: "Find the cheapest morning flight from Porto to Lisbon for the 14th, back on the 18th.",
      criteria: [
        { id: "c1", text: "A return fare under €220", met: true },
        { id: "c2", text: "Leaves before 9 AM", met: true },
      ],
      worked: [
        { item: "i1", text: "Compared TAP, Ryanair and easyJet for both days" },
        { item: "i2", text: "Saved the price history to fares-history.csv" },
      ],
      failed: [],
      missing: [],
      note: "TAP's 07:40 at €212 is the one; it rose €12 last week, so worth booking soon.",
    },
  });
  knowledge.addEpisode({
    agent: "flights",
    title: "Hotel shortlist near Chiado",
    outcome: "failed",
    untrusted: true,
    cost_micros: 90_000,
    started_at: days(2) - 3_600_000,
    closed_at: days(2),
    episode: {
      text: "Shortlist three hotels under €180 a night near Chiado.",
      criteria: [{ id: "c1", text: "Three hotels under €180", met: false }],
      worked: [{ item: "i1", text: "Found two under €180" }],
      failed: [{ item: "i2", text: "Find a third", why: "Every other one was over €200" }],
      missing: ["A third hotel"],
    },
  });

  const watcher = spade.services.start("flights", {
    name: "fare watcher",
    command: "python fares.py --watch --to LIS --from OPO",
    keep: true,
  });
  watcher.output.push(
    "Watching OPO → LIS, 14–18 Nov, every 10 minutes",
    "09:00 TAP €224 · Ryanair €231 · easyJet €248",
    "09:10 TAP €224 · Ryanair €231 · easyJet €248",
    "09:20 TAP €212 · Ryanair €231 · easyJet €244",
    "09:20 New low: TAP €212",
  );
  spade.services
    .start("flights", {
      name: "price page",
      command: "python -m http.server 8040 --directory charts",
    })
    .output.push("Serving HTTP on :: port 8040 (http://[::]:8040/) ...");
  const tail = spade.services.start("flights", {
    name: "alerts tail",
    command: "ssh fares.example.net tail -f alerts.log",
    state: "exited",
    exit_code: 255,
  });
  tail.output.push("ssh: connect to host fares.example.net port 22: Connection refused");

  spade.fastModel = "openrouter/openai/gpt-6.1-mini";
  spade.roles.strongest = "openrouter/anthropic/claude-sonnet-5.5";
  spade.roles.bots.set("flights", {
    roles: {
      helper: null,
      verify: null,
      review: null,
      compact: "openrouter/anthropic/claude-sonnet-5.5",
      title: null,
    },
    escalate: null,
  });
  spade.roles.spend.set("flights", {
    helper: 420_000,
    verify: 90_000,
    review: 30_000,
    compact: 20_000,
  });
}
