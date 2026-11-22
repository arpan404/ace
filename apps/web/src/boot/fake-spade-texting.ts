import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, Tess texts like a person (ADR 0212): one turn as three short messages, a
 * reply that quotes an older question and puts the week's plan in a document card, the person's
 * reply quoting Tess's fare, and a turn still arriving in short messages under the working line.
 */
export function seedFakeTexting(here: FakeSpadeApi, minutes: (count: number) => number) {
  const tess = here.addAgent({
    id: "tess",
    name: "Tess",
    task: "Plan the Lisbon trip: flights, a hotel near Alfama and the days.",
  });
  const store = (event: Record<string, unknown>, ago: number) =>
    here.store(tess.conversation, event, minutes(ago));
  // seq 1–4: the question, and three short messages back.
  store({ type: "user_message", text: "Can you find me flights to Lisbon for the 14th?" }, 42);
  store({ type: "reply_started", reply: "r-tess-1" }, 42);
  const fares = [
    "<msg>Found 3 flights under €100.</msg>",
    "<msg>The cheapest is TAP, Tuesday at 9:10, €78 return.</msg>",
    "<msg>Want me to hold it?</msg>",
  ].join("\n");
  store({ type: "step_finished", reply: "r-tess-1", text: fares }, 41);
  store({ type: "reply_finished", reply: "r-tess-1", text: fares }, 41);
  // seq 5–9: two questions, then a reply to the older one and the plan as a document.
  store({ type: "user_message", text: "Does the hotel near Alfama have breakfast?" }, 39);
  store({ type: "user_message", text: "And can you put together a plan for the week?" }, 39);
  store({ type: "reply_started", reply: "r-tess-2" }, 39);
  const plan = [
    '<msg reply="m5">Yes, breakfast is included at Casa Alfama.</msg>',
    "<msg>Here's the week, one slow thing a day.</msg>",
    '<doc title="Lisbon trip plan">',
    "## The week",
    "",
    "| Day | Morning | Evening |",
    "| --- | --- | --- |",
    "| Tue 14 | Land 11:35, check in | Dinner in Alfama |",
    "| Wed 15 | Castelo de São Jorge | Fado at Clube de Fado |",
    "| Thu 16 | Belém and the tower | Sunset at Miradouro da Graça |",
    "| Fri 17 | LX Factory | Time Out Market |",
    "| Sat 18 | Sintra day trip | Pack |",
    "",
    "## Bookings",
    "",
    "- Flight: TAP, held until 6 PM today",
    "- Hotel: Casa Alfama, 4 nights, breakfast included",
    "- Fado: two seats, Wednesday 9 PM",
    "</doc>",
  ].join("\n");
  store({ type: "step_finished", reply: "r-tess-2", text: plan }, 38);
  store({ type: "reply_finished", reply: "r-tess-2", text: plan }, 38);
  // seq 10: the person replies to Tess's fare, and Tess answers in short messages as they arrive.
  store(
    {
      type: "user_message",
      text: "Tuesday works, hold the 9:10.",
      reply_to: {
        id: "m3.2",
        text: "The cheapest is TAP, Tuesday at 9:10, €78 return.",
        mine: false,
      },
    },
    1,
  );
  store({ type: "reply_started", reply: "r-tess-3" }, 1);
  store(
    {
      type: "reply_progress",
      reply: "r-tess-3",
      text: "<msg>Holding it now.</msg>\n<msg>Checking if an aisle seat is still",
    },
    0,
  );
  here.status(tess, "working", "Holding the 9:10 fare");
  tess.last_message = {
    from: "person",
    text: "Tuesday works, hold the 9:10.",
    at: minutes(1),
    from_agent: null,
  };
  return tess;
}
