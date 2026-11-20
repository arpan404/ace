import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * Reaching the person in `?fakeWorld=spade` (ADR 0195): this morning's brief in Spade's chat,
 * with what finished overnight, the email Inbox waits on and today's routines; Flights' spend
 * alert; do not disturb on with three notices waiting.
 */
export function seedFakeReach(here: FakeSpadeApi, now: number) {
  const hours = (count: number) => now - count * 3_600_000;
  here.reach.settings = {
    ...here.reach.settings,
    dnd: true,
    quiet: { from: 22 * 60, to: 7 * 60 },
    brief: { on: true, at: 8 * 60, bots: null, polish: false },
  };
  here.reach.held = 3;
  here.wakes.digests.push(
    {
      id: "brief-1",
      agent: "spade",
      kind: "brief",
      scheduled: true,
      from_ms: hours(24),
      to_ms: now - 2_000,
      made_ms: now - 2_000,
      text: "Since yesterday 8:00: 2 finished, 1 waiting on you.",
      polished: null,
      digest: {
        finished: [
          {
            agent: "notes",
            name: "Release notes",
            conversation: "c-notes",
            seq: 12,
            text: "Draft 0.0.22 notes finished after 1h 12m.",
          },
          {
            agent: "flights",
            name: "Flights",
            conversation: "c-flights",
            seq: 30,
            text: "Fare check: TAP direct on the 14th dropped to $812.",
          },
        ],
        waiting: [
          {
            agent: "inbox",
            name: "Inbox",
            conversation: "c-inbox",
            kind: "approval",
            call_id: "k-mail",
            what: "Wants your yes to use send_email: It sends a message as you, so you decide.",
            answer: "approval",
          },
        ],
        today: [{ name: "Flights", routine: "Fare check", at_ms: now + 2 * 3_600_000 }],
        spend: {
          total_micros: 3_480_000,
          bots: [
            { name: "Flights", micros: 2_100_000 },
            { name: "Release notes", micros: 1_380_000 },
          ],
        },
        away: [{ name: "Garden", text: "Watering check: the tomatoes need water today." }],
      },
    },
    {
      id: "spend-1",
      agent: "flights",
      kind: "spend",
      scheduled: false,
      from_ms: hours(1.5),
      to_ms: hours(0.5),
      made_ms: hours(0.5),
      text: "Spent $4.20 in the last hour, about 6× its usual $0.70 an hour.",
      polished: null,
    },
  );
}
