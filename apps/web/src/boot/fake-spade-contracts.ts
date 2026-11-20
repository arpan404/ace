import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`'s contract calls (ADR 0200 §7): Trip planner asks Fare watch (a packaged bot,
 * `fake-spade-packages.ts`) for `cheapest_fare` and reads its typed answer, then asks Hotel scout
 * on the studio for `cheapest_room`, still open. Fare watch's chat holds the request as Trip
 * planner's, answered with `contract_return`.
 */
export function seedFakeContracts(here: FakeSpadeApi, now: number): void {
  const planner = here.addAgent({
    id: "trip-planner",
    name: "Trip planner",
    task: "Plan my trips: fares, places to stay and what to book when.",
    avatar: {
      kind: "character",
      v: 1,
      body: "round",
      pair: "peach",
      ears: "cat",
      marking: "none",
      eyes: "round",
      mouth: "smile",
      cheeks: "blush",
      accessory: "none",
    },
    last_activity: now - 2 * 60_000,
  });
  const watcher = here.agents.find((agent) => agent.id === "fare-watch");
  const call = "cc.trip-planner.k1";
  const input = { from: "OPO", to: "LIS", month: "2027-05" };
  here.store(planner.conversation, {
    type: "user_message",
    text: "Plan Porto to Lisbon in May: the cheapest fare, and somewhere to stay near the river.",
  });
  here.store(planner.conversation, { type: "reply_started", reply: "r-plan" });
  here.store(planner.conversation, {
    type: "step_finished",
    reply: "r-plan",
    text: "",
    calls: [
      {
        id: "k1",
        name: "contract_call",
        arguments: { bot: "Fare watch", contract: "cheapest_fare", input },
      },
      {
        id: "k2",
        name: "contract_call",
        arguments: {
          bot: "Hotel scout",
          machine: "Studio",
          contract: "cheapest_room",
          input: { city: "Lisbon", near: "the river", month: "2027-05" },
        },
      },
    ],
  });
  for (const [job, bot, contract, machine] of [
    ["k1", "Fare watch", "cheapest_fare", undefined],
    ["k2", "Hotel scout", "cheapest_room", "Studio"],
  ] as const) {
    here.store(planner.conversation, {
      type: "tool_started",
      reply: "r-plan",
      call_id: job,
      name: "contract_call",
    });
    here.store(planner.conversation, {
      type: "job_started",
      reply: "r-plan",
      job,
      name: "contract_call",
    });
    here.store(planner.conversation, {
      type: "contract_called",
      job,
      call: `cc.trip-planner.${job}`,
      bot: bot === "Fare watch" ? "fare-watch" : "hotel-scout",
      name: bot,
      ...(machine ? { machine: "host-studio", machine_name: machine } : {}),
      contract,
    });
    here.store(planner.conversation, {
      type: "tool_finished",
      reply: "r-plan",
      call_id: job,
      name: "contract_call",
      content: `Started in the background as job ${job}.`,
    });
  }
  here.store(planner.conversation, {
    type: "reply_finished",
    reply: "r-plan",
    text: "I've asked Fare watch for the fare and Hotel scout for a room. I'll put it together when they answer.",
  });
  here.store(planner.conversation, {
    type: "job_finished",
    job: "k1",
    name: "contract_call",
    content: `<contract_result call="${call}" bot="Fare watch" contract="cheapest_fare" status="returned">\n${JSON.stringify(
      { fare: 78, currency: "EUR", carrier: "TAP", seen_at: "today 07:40" },
      null,
      2,
    )}\n</contract_result>`,
  });
  here.store(planner.conversation, { type: "reply_started", reply: "r-plan-2" });
  here.store(planner.conversation, {
    type: "reply_finished",
    reply: "r-plan-2",
    text: "The cheapest fare is €78 with TAP, seen this morning. Still waiting on a room.",
  });
  if (!watcher) return;
  here.store(watcher.conversation, {
    type: "user_message",
    text: `cheapest_fare: ${JSON.stringify(input)}`,
    from_agent: {
      id: planner.id,
      name: planner.name,
      depth: 1,
      contract: { call, contract: "cheapest_fare", input },
    },
  });
  here.store(watcher.conversation, { type: "reply_started", reply: "r-call" });
  here.store(watcher.conversation, {
    type: "step_finished",
    reply: "r-call",
    text: "",
    calls: [
      {
        id: "w1",
        name: "contract_return",
        arguments: { call, output: { fare: 78, currency: "EUR", carrier: "TAP" } },
      },
    ],
  });
  here.store(watcher.conversation, {
    type: "tool_started",
    reply: "r-call",
    call_id: "w1",
    name: "contract_return",
  });
  here.store(watcher.conversation, {
    type: "contract_ended",
    call,
    status: "returned",
    output: { fare: 78, currency: "EUR", carrier: "TAP" },
    untrusted: false,
  });
  here.store(watcher.conversation, {
    type: "tool_finished",
    reply: "r-call",
    call_id: "w1",
    name: "contract_return",
    content: "Returned. The caller has the answer.",
  });
  here.store(watcher.conversation, {
    type: "reply_finished",
    reply: "r-call",
    text: "Sent Trip planner the cheapest fare: €78 with TAP.",
  });
}
