import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, a bot's notices and a package it suggests (ADR 0200 §4.2, §8): Trip planner sent
 * one notice that reached the person and one held through quiet hours, then suggested the
 * market's Flight watcher and waits on the card. For checking both by eye in both schemes.
 */
export function seedFakeSuggest(here: FakeSpadeApi) {
  const bot = here.addAgent({
    id: "trip-planner",
    name: "Trip planner",
    task: "Plan the person's trips and keep an eye on what they book.",
    avatar: {
      kind: "character",
      v: 1,
      body: "square",
      pair: "sunset",
      ears: "none",
      marking: "none",
      eyes: "round",
      mouth: "smile",
      cheeks: "none",
      accessory: "none",
    },
  });
  const say = (text: string) => here.store(bot.conversation, { type: "user_message", text });
  const notice = (call: string, title: string, body: string, reach: string, why?: string) =>
    here.store(bot.conversation, {
      type: "notice_sent",
      call_id: call,
      id: `notice:${bot.conversation}:${call}`,
      title,
      body,
      reach,
      ...(why ? { why } : {}),
    });
  say("Tell me if anything about the Lisbon trip changes.");
  notice("n1", "Check-in is open", "TAP 1347 on 14 May: check-in opened at 07:40.", "now");
  notice(
    "n2",
    "Gate changed",
    "Your return flight now leaves from gate 14, not 9.",
    "held",
    "quiet",
  );
  say("I keep checking fares by hand every morning. Can you help?");
  here.card(bot, "s-trips", [
    {
      prompt:
        "You check fares by hand every morning; this watches them and tells you about real drops.",
      kind: "suggest",
      source: "market",
      package: "flight-watcher",
      version: "2.1.0",
      name: "Flight watcher",
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
      blurb: "Watches fares for the trips you name and tells you when one drops.",
      publisher: { id: "pub_harbour", name: "harbour" },
      can: ["Reach api.example-fares.com", "Send messages as you", "Run on a schedule"],
    },
  ]);
}
