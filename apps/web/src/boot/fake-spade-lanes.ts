import type { FakeSpadeApi } from "@ace/fake-daemon";
import { laneById, lanesBot } from "@/features/spade/lanes/lanes-fixture.ts";

/*
 * `?fakeWorld=spade-lanes`: the Spade world, plus Errands, a bot running five task lanes
 * (prototype for ADR 0217, proposed). Its main chat holds every lane line: started (with live
 * progress), a quick answer while tasks run, main's long work moved to a lane by itself, a reply
 * sent to a lane, a lane done, one stopped early, and one waiting on the person for a payment.
 * Each lane's own conversation is stored too, so opening one shows its transcript.
 * Add `&lane=lane-invoice` to open a lane, `&tasks=popover` or `&tasks=panel` for the list.
 */
export function seedFakeLanes(here: FakeSpadeApi) {
  const now = Date.now();
  const at = (minutes: number) => now - minutes * 60_000;
  const bot = here.addAgent({
    id: lanesBot,
    name: "Errands",
    task: "Handle my errands: invoices, travel, files and quotes.",
    state: "waiting",
    waiting_for: "approval",
    status: "Book flights to Lisbon needs you",
    last_activity: at(1),
  });
  const c = bot.conversation;
  let n = 0;
  const store = (event: Record<string, unknown>, minutes: number) =>
    here.store(c, event, at(minutes));
  const say = (text: string, minutes: number, extra: Record<string, unknown> = {}) =>
    store({ type: "user_message", text, ...extra }, minutes);
  const reply = (text: string, minutes: number) => {
    const id = `r-errands-${++n}`;
    store({ type: "reply_started", reply: id }, minutes);
    store({ type: "step_finished", reply: id, text }, minutes);
    store({ type: "reply_finished", reply: id, text }, minutes);
  };
  const started = (lane: string, minutes: number) =>
    store(
      {
        type: "lane_started",
        lane,
        conversation: laneById(lane)?.conversation ?? "",
        title: laneById(lane)?.title ?? "",
      },
      minutes,
    );
  const reported = (lane: string, state: string, minutes: number) =>
    store(
      { type: "worker_reported", worker: lane, kind: "lane", name: laneById(lane)?.title, state },
      minutes,
    );

  say("The March invoice has the VAT line wrong. Fix it and send it to Dana once it's right.", 12);
  reply("On it. I'll fix the VAT line, check the totals, then send it to Dana.", 12);
  started("lane-invoice", 12);

  say("Also book flights to Lisbon, out on the 14th and back the 18th. Window seat.", 10);
  reply("Started on the flights. I'll check with you before paying for anything.", 10);
  started("lane-flights", 10);

  // A quick question while two tasks run: answered here, in one step.
  say("What time is it in Lisbon right now?", 8);
  reply("It's 2:32 PM in Lisbon, an hour behind you.", 8);

  // Main started on this itself; it ran long, so Spade moved it to a lane.
  say("Draft the quarterly note from the numbers in Q3.xlsx.", 6);
  const long = `r-errands-${++n}`;
  store({ type: "reply_started", reply: long }, 6);
  store(
    {
      type: "step_finished",
      reply: long,
      text: "",
      calls: [
        { id: "q-read", name: "workspace_read", arguments: { path: "Q3.xlsx" } },
        { id: "q-last", name: "workspace_read", arguments: { path: "notes/Q2-note.md" } },
      ],
    },
    6,
  );
  for (const call of ["q-read", "q-last"]) {
    store({ type: "tool_started", reply: long, call_id: call, name: "workspace_read" }, 6);
    store(
      {
        type: "tool_finished",
        reply: long,
        call_id: call,
        name: "workspace_read",
        content: "ok",
        is_error: false,
      },
      5,
    );
  }
  store({ type: "reply_finished", reply: long, text: "" }, 4);
  store(
    { type: "reply_moved", lane: "lane-quarterly", title: laneById("lane-quarterly")?.title },
    4,
  );

  say("Clean up the shared drive: one folder per client.", 5);
  reply("I'll sort it into client folders. Nothing gets deleted.", 5);
  started("lane-drive", 5);

  say("And compare the three CRM quotes in /quotes.", 4);
  reply("Comparing them now.", 4);
  started("lane-crm", 4);

  // A reply to the invoice message goes to that task without a model call.
  say("Send it to her work address, dana@northwind.co.", 3, {
    reply_to: {
      id: "m2",
      text: "On it. I'll fix the VAT line, check the totals, then send it to Dana.",
      mine: false,
    },
  });
  store({ type: "ask_routed", lane: "lane-invoice", title: laneById("lane-invoice")?.title }, 3);

  reported("lane-drive", "done", 2);
  reply(
    "The shared drive is tidy: 214 files in six client folders. Nothing was deleted, and every move is listed in drive-moves.md.",
    2,
  );

  reported("lane-crm", "failed", 1);
  reply(
    "The CRM comparison stopped early: HubSpot's pricing page wouldn't load after three tries. Pipedrive and Attio are side by side in crm.md.",
    1,
  );

  reported("lane-flights", "needs_you", 1);
  reply(
    "The flights are ready: TAP, out on the 14th at 9:10, back on the 18th at 18:40, window seats both ways, €412 in all. Paying needs your OK.",
    1,
  );
  store(
    {
      type: "approval_requested",
      reply: "r-lane-flights",
      call_id: "lane-flights.pay",
      name: "send_payment",
      arguments: {
        amount: "€412",
        to: "TAP Air Portugal",
        booking: "LIS 14th 9:10, back 18th 18:40",
      },
      effect: "pay",
      lane: { conversation: "c-lane-flights", title: "Book flights to Lisbon" },
    },
    1,
  );

  seedLaneConversations(here, at);
}

/** Each lane's own transcript: the person's words first, then the task's work. */
function seedLaneConversations(here: FakeSpadeApi, at: (minutes: number) => number) {
  const invoice = "c-lane-invoice";
  const s = (event: Record<string, unknown>, minutes: number) =>
    here.store(invoice, event, at(minutes));
  s(
    {
      type: "user_message",
      text: "The March invoice has the VAT line wrong. Fix it and send it to Dana once it's right.",
    },
    12,
  );
  s({ type: "reply_started", reply: "r-li" }, 12);
  s(
    {
      type: "goal_set",
      goal: "g-invoice",
      title: "Fix the March invoice and send it to Dana",
      text: "The March invoice has the VAT line wrong.",
      by: "bot",
    },
    12,
  );
  s(
    {
      type: "step_finished",
      reply: "r-li",
      text: "",
      calls: [
        { id: "li-read", name: "workspace_read", arguments: { path: "invoices/2026-03.xlsx" } },
      ],
    },
    11,
  );
  s({ type: "tool_started", reply: "r-li", call_id: "li-read", name: "workspace_read" }, 11);
  s(
    {
      type: "tool_finished",
      reply: "r-li",
      call_id: "li-read",
      name: "workspace_read",
      content: "ok",
      is_error: false,
    },
    11,
  );
  s(
    {
      type: "step_finished",
      reply: "r-li",
      text: "The VAT line used 2% instead of 20%. Correcting it and the totals.",
      calls: [
        { id: "li-write", name: "workspace_edit", arguments: { path: "invoices/2026-03.xlsx" } },
        {
          id: "li-pdf",
          name: "shell",
          arguments: { command: "soffice --convert-to pdf 2026-03.xlsx" },
        },
      ],
    },
    9,
  );
  for (const [call, name] of [
    ["li-write", "workspace_edit"],
    ["li-pdf", "shell"],
  ] as const) {
    s({ type: "tool_started", reply: "r-li", call_id: call, name }, 9);
    s(
      { type: "tool_finished", reply: "r-li", call_id: call, name, content: "ok", is_error: false },
      7,
    );
  }
  s(
    {
      type: "step_finished",
      reply: "r-li",
      text: "Fixed: VAT is now €1,284.00 and the total €7,704.00. Drafting the email to Dana next.",
    },
    6,
  );
  // The person's reply in main, sent here as their own words.
  s({ type: "user_message", text: "Send it to her work address, dana@northwind.co." }, 3);
  s(
    {
      type: "step_finished",
      reply: "r-li",
      text: "Got it, dana@northwind.co. Writing the email now.",
    },
    2,
  );

  // The others' first messages, so each opens on its own words.
  for (const id of ["lane-flights", "lane-quarterly", "lane-drive", "lane-crm"]) {
    const lane = laneById(id);
    if (!lane) continue;
    const task = lane.task as { goal?: { text?: string } };
    here.store(
      lane.conversation,
      { type: "user_message", text: task.goal?.text ?? lane.title },
      at(lane.startedMin),
    );
  }
}
