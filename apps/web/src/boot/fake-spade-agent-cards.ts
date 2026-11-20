import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, a bot's cards (ADR 0200 §5.1): Fare watch asked to watch a route, showed a
 * card in most block kinds, then updated it in place when the fare moved again, and waits for the
 * person's choice on it. For checking cards by eye in both schemes.
 */
/** The fare card as it stood at each check. */
const card = (fare: string, change: string, checked: number) => ({
  title: "Porto to Lisbon, 14 May",
  blocks: [
    { kind: "metric", label: "Cheapest fare", value: fare, unit: "EUR", change },
    {
      kind: "fields",
      rows: [
        { label: "Leaves", value: "07:40, back 19:15" },
        { label: "Your limit", value: "€90" },
      ],
    },
    { kind: "progress", label: "Carriers checked", value: checked, max: 4 },
    {
      kind: "table",
      columns: ["Carrier", "Fare", "Bag"],
      rows: [
        ["TAP", fare, "Included"],
        ["Ryanair", "79", "€25"],
      ],
    },
    {
      kind: "link",
      url: "https://fares.example.com/opo-lis",
      host: "fares.example.com",
      label: "The fare",
    },
    {
      kind: "actions",
      actions: [
        { kind: "choose", id: "keep", label: "Keep watching" },
        { kind: "choose", id: "stop", label: "Stop" },
        {
          kind: "open",
          label: "Book",
          url: "https://www.flytap.example/book",
          host: "flytap.example",
        },
      ],
    },
  ],
});

export function seedFakeAgentCards(here: FakeSpadeApi) {
  const bot = here.addAgent({
    id: "fares",
    name: "Fare watch",
    task: "Watch fares for the trips I name and tell me about real drops.",
    avatar: {
      kind: "character",
      v: 1,
      body: "bird",
      pair: "sky",
      ears: "none",
      marking: "none",
      eyes: "round",
      mouth: "smile",
      cheeks: "none",
      accessory: "none",
    },
  });
  here.store(bot.conversation, {
    type: "user_message",
    text: "Watch Porto to Lisbon for the 14th, under €90.",
  });
  here.store(bot.conversation, { type: "reply_started", reply: "r-fares" });
  here.store(bot.conversation, {
    type: "step_finished",
    reply: "r-fares",
    text: "Watching it. Here's where it stands now.",
    calls: [{ id: "s-fares", name: "card_show" }],
  });
  here.showCard(bot, "card-fares", 1, card("84", "−6 since this morning", 3));
  here.store(bot.conversation, {
    type: "reply_finished",
    reply: "r-fares",
    text: "Watching it. Here's where it stands now.",
  });
  here.showCard(bot, "card-fares", 2, card("78", "−12 since this morning", 4));
}
