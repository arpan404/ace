import { stageFakeLanes, type FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade-lanes`: the Spade world, plus Errands, a bot running its tasks in lanes
 * (ADR 0217): one waiting on the person to pay, two running (one Spade moved from its chat), one
 * done, one stopped early and one queued, with every line main's chat shows for them.
 */
export function seedFakeLanes(here: FakeSpadeApi) {
  const now = Date.now();
  const bot = here.addAgent({
    id: "errands",
    name: "Errands",
    task: "Handle my errands: invoices, travel, files and quotes.",
    state: "waiting",
    waiting_for: "approval",
    status: "Book flights to Lisbon needs you",
    last_activity: now - 60_000,
  });
  stageFakeLanes(
    here.lanes,
    {
      store: (conversation, event, at) => here.store(conversation, event, at),
      events: (conversation) => here.eventsOf(conversation),
      now: () => now,
    },
    bot.conversation,
  );
}
