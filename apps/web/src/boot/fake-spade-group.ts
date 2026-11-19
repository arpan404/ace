import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, a group: Lisbon trip, with Spade leading Flights and Inbox, for checking
 * by eye what a group's conversation and profile draw. The person asks, Spade hands off, each
 * member's turn starts with its face and name, and Flights left two files in the Library.
 */
export function seedFakeGroup(here: FakeSpadeApi, now: number) {
  const spade = { id: "spade", name: "Spade", machine: null };
  const flights = { id: "flights", name: "Flights", machine: null };
  const inbox = { id: "inbox", name: "Inbox", machine: null };
  const group = here.teams.addGroup({
    id: "lisbon",
    name: "Lisbon trip",
    members: [here.teams.member("spade"), here.teams.member("flights"), here.teams.member("inbox")],
    last_message: {
      from: "agent",
      text: "The TAP booking is in your inbox: QX7K2P.",
      at: now - 4 * 60_000,
      agent: inbox,
    },
    files: [
      { agent: "flights", path: "fares-history.csv", at: now - 6 * 60_000 },
      { agent: "flights", path: "flights.md", at: now - 9 * 60_000 },
    ],
  });
  const c = group.conversation;
  const say = (text: string, from: typeof spade | null = null) =>
    here.store(c, { type: "group_message", run: "u1", text, from });
  const asked = (ask: string, by: typeof spade | null, to: typeof spade) =>
    here.store(c, { type: "group_asked", run: "u1", ask, by, to, depth: by ? 2 : 1 });
  say(
    "Find me the cheapest flight to Lisbon for the 14th to the 18th, and check I haven't booked already.",
  );
  asked("a1", null, spade);
  say("Flights will check fares; Inbox will look for a booking you already have.", spade);
  asked("a2", spade, flights);
  say(
    "Cheapest return from OPO:\n\n1. **TAP TP1351**, 07:40, €212\n2. **Ryanair FR8342**, 13:05, €188 plus €46 for a bag\n\nTAP is cheaper once you carry a bag.",
    flights,
  );
  say("Fares are in `fares-history.csv` if you want the last week.", flights);
  asked("a3", spade, inbox);
  say("The TAP booking is in your inbox: QX7K2P. You booked it on the 9th.", inbox);
  for (const ask of ["a1", "a2", "a3"])
    here.store(c, {
      type: "group_answered",
      run: "u1",
      ask,
      to: ask === "a1" ? spade : ask === "a2" ? flights : inbox,
      outcome: "answered",
    });
}
