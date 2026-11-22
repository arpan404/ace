import type { FakeSpadeAgent, FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, bots talking with bots (ADR 0127, ADR 0200 §7). Quill asks Writing for a
 * launch intro, which Writing answers, and asks Flight watcher's `cheapest_fare` (returned) and
 * `seat_map` (failed). A later turn asks Writing for a title, which Writing is still writing:
 * Quill's card waits on it, and Writing's own chat shows the message from Quill and its answer
 * to the first, marked as going back. Flight watcher's chat holds both calls as Quill's.
 */
export function seedFakeTalk(here: FakeSpadeApi, quill: FakeSpadeAgent): void {
  const writing = here.addAgent({
    id: "writing",
    name: "Writing",
    task: "Draft, edit and tighten what I write.",
    state: "working",
    status: "Drafting a title",
    avatar: {
      kind: "character",
      v: 1,
      body: "egg",
      pair: "lilac",
      ears: "fox",
      marking: "none",
      eyes: "sleepy",
      mouth: "smile",
      cheeks: "blush",
      accessory: "none",
    },
  });
  const watcher = here.addAgent({
    id: "flight-watcher",
    name: "Flight watcher",
    task: "Watch fares for the trips I plan.",
    avatar: {
      kind: "character",
      v: 1,
      body: "round",
      pair: "mint",
      ears: "none",
      marking: "none",
      eyes: "round",
      mouth: "smile",
      cheeks: "none",
      accessory: "none",
    },
  });
  const sender = (event: Record<string, unknown>) => here.store(quill.conversation, event);
  const intro = "Can you draft a two-line intro for the Lisbon trip notes page?";
  const introAnswer =
    "Three days on the river, two on the hills, one long lunch in Sintra. Everything we booked, ate and meant to see, in one place.";
  const title = "And a short title for the page, please: something warmer than “Lisbon trip”.";
  const fare = { from: "OPO", to: "LIS", month: "2027-05" };

  sender({
    type: "user_message",
    text: "Get Writing to draft an intro for the trip notes, and check fares for Lisbon in May.",
  });
  sender({ type: "reply_started", reply: "r-talk-1" });
  sender({
    type: "step_finished",
    reply: "r-talk-1",
    text: "",
    calls: [
      { id: "t1", name: "bot_message", arguments: { bot: "writing", text: intro } },
      {
        id: "t2",
        name: "contract_call",
        arguments: { bot: "Flight watcher", contract: "cheapest_fare", input: fare },
      },
      {
        id: "t3",
        name: "contract_call",
        arguments: { bot: "Flight watcher", contract: "seat_map", input: { flight: "TP1951" } },
      },
    ],
  });
  for (const [job, name] of [
    ["t1", "bot_message"],
    ["t2", "contract_call"],
    ["t3", "contract_call"],
  ] as const) {
    sender({ type: "tool_started", reply: "r-talk-1", call_id: job, name });
    sender({ type: "job_started", reply: "r-talk-1", job, name });
    if (name === "contract_call")
      sender({
        type: "contract_called",
        job,
        call: `cc.quill.${job}`,
        bot: watcher.id,
        name: watcher.name,
        contract: job === "t2" ? "cheapest_fare" : "seat_map",
      });
    sender({
      type: "tool_finished",
      reply: "r-talk-1",
      call_id: job,
      name,
      content: `Started in the background as job ${job}.`,
    });
  }
  sender({
    type: "reply_finished",
    reply: "r-talk-1",
    text: "I've asked Writing for the intro and Flight watcher for fares.",
  });
  sender({
    type: "job_finished",
    job: "t2",
    name: "contract_call",
    content: `<contract_result call="cc.quill.t2" bot="Flight watcher" contract="cheapest_fare" status="returned">\n${JSON.stringify(
      { fare: 78, currency: "EUR", carrier: "TAP" },
      null,
      2,
    )}\n</contract_result>`,
  });
  sender({
    type: "job_finished",
    job: "t3",
    name: "contract_call",
    is_error: true,
    content:
      '<contract_result call="cc.quill.t3" status="failed">\nThe airline\'s seat map is closed until check-in opens.\n</contract_result>',
  });
  sender({
    type: "job_finished",
    job: "t1",
    name: "bot_message",
    content: `Writing answered:\n${introAnswer}`,
  });
  sender({ type: "reply_started", reply: "r-talk-2" });
  const wrapped =
    "The cheapest fare is €78 with TAP. Writing's intro is in; the seat map opens at check-in.";
  sender({ type: "step_finished", reply: "r-talk-2", text: wrapped });
  sender({ type: "reply_finished", reply: "r-talk-2", text: wrapped });

  sender({ type: "user_message", text: "Lovely. Ask it for a title too." });
  sender({ type: "reply_started", reply: "r-talk-3" });
  sender({
    type: "step_finished",
    reply: "r-talk-3",
    text: "",
    calls: [{ id: "t4", name: "bot_message", arguments: { bot: "writing", text: title } }],
  });
  sender({ type: "tool_started", reply: "r-talk-3", call_id: "t4", name: "bot_message" });
  sender({ type: "job_started", reply: "r-talk-3", job: "t4", name: "bot_message" });
  sender({
    type: "tool_finished",
    reply: "r-talk-3",
    call_id: "t4",
    name: "bot_message",
    content: "Started in the background as job t4.",
  });
  sender({ type: "reply_finished", reply: "r-talk-3", text: "Asked. I'll tell you what it says." });

  // Writing's chat: Quill's two messages, the first answered back to it, the second in hand.
  const from = { id: quill.id, name: quill.name, depth: 1 };
  const receiver = (event: Record<string, unknown>) => here.store(writing.conversation, event);
  receiver({ type: "user_message", text: intro, from_agent: from });
  receiver({ type: "reply_started", reply: "r-w-1" });
  receiver({ type: "step_finished", reply: "r-w-1", text: introAnswer });
  receiver({ type: "reply_finished", reply: "r-w-1", text: introAnswer });
  receiver({ type: "user_message", text: title, from_agent: from });
  receiver({ type: "reply_started", reply: "r-w-2" });

  // Flight watcher's chat: both calls, as Quill's.
  const callee = (event: Record<string, unknown>) => here.store(watcher.conversation, event);
  const asks = [
    ["cc.quill.t2", "cheapest_fare", fare],
    ["cc.quill.t3", "seat_map", { flight: "TP1951" }],
  ] as const;
  for (const [call, contract, input] of asks) {
    callee({
      type: "user_message",
      text: `${contract}: ${JSON.stringify(input)}`,
      from_agent: { ...from, contract: { call, contract, input } },
    });
    callee({ type: "reply_started", reply: `r-${call}` });
    callee(
      contract === "cheapest_fare"
        ? {
            type: "contract_ended",
            call,
            status: "returned",
            output: { fare: 78, currency: "EUR", carrier: "TAP" },
            untrusted: false,
          }
        : {
            type: "contract_ended",
            call,
            status: "failed",
            problems: ["The airline's seat map is closed until check-in opens."],
          },
    );
    callee({ type: "reply_finished", reply: `r-${call}`, text: "" });
  }
}
