import type { FakeLanesHost, FakeSpadeLanes } from "./spade-lanes.ts";

const plan = (texts: readonly string[], done: number) =>
  texts.map((text, at) => ({ text, done: at < done }));

/**
 * Stores a realistic set of lanes for the bot whose conversation is `main`, as `?fakeWorld` and
 * tests use: the person's asks and the bot's short answers in main, each task started there, a
 * quick question answered in main while tasks run, main's long work moved to a task by Spade, a
 * reply routed to a running task, one task done, one stopped early, one queued, and one waiting
 * on the person to pay.
 */
export function stageFakeLanes(lanes: FakeSpadeLanes, host: FakeLanesHost, main: string): void {
  const now = host.now();
  const minute = 60_000;
  const model = "openai/gpt-5.4";
  let replies = 0;
  const person = (text: string, extra: Record<string, unknown> = {}) =>
    host.store(main, { type: "user_message", text, ...extra });
  const answer = (text: string) => {
    const reply = `${main}-r${++replies}`;
    host.store(main, { type: "reply_started", reply, model });
    host.store(main, { type: "reply_finished", reply, text, cost_micros: 2_000 });
  };

  const invoiceAsk =
    "The March invoice has the VAT line wrong. Fix it and send it to Dana once it's right.";
  person(invoiceAsk);
  answer("On it. I'll fix the VAT line, check the totals, then send it to Dana.");
  const invoice = `${main}-lane-invoice`;
  lanes.start({
    task: invoice,
    main,
    title: "Fix the March invoice",
    words: invoiceAsk,
    goal: "Fix the March invoice and send it to Dana",
    criteria: [
      "VAT is 20% of the net total",
      "The totals add up",
      "Dana has the corrected invoice at dana@northwind.co",
    ],
    state: "working",
    plan: [
      { text: "Find why the VAT line is wrong", done: true, evidence: "invoices/2026-03.xlsx" },
      { text: "Correct VAT and the totals", done: true, evidence: "invoices/2026-03.pdf" },
      ...plan(["Draft the email to Dana", "Send it to dana@northwind.co", "Save the sent copy"], 0),
    ],
    startedMs: now - 12 * minute,
    costMicros: 380_000,
    asks: ["m1"],
    moved: false,
    model,
  });
  host.store(invoice, {
    type: "step_finished",
    reply: `r-${invoice}`,
    text: "The VAT line used 2% instead of 20%. Correcting it and the totals.",
    calls: [],
  });
  host.store(invoice, {
    type: "step_finished",
    reply: `r-${invoice}`,
    text: "Fixed: VAT is now €1,284.00 and the total €7,704.00. Drafting the email to Dana next.",
    calls: [],
  });

  const flightsAsk = "Also book flights to Lisbon, out on the 14th and back the 18th. Window seat.";
  person(flightsAsk);
  answer("Started on the flights. I'll check with you before paying for anything.");
  const flights = `${main}-lane-flights`;
  lanes.start({
    task: flights,
    main,
    title: "Book flights to Lisbon",
    words: flightsAsk,
    state: "working",
    plan: plan(
      [
        "Compare fares for the 14th and the 18th",
        "Pick the cheapest with window seats",
        "Fill in the booking",
        "Pay and save the confirmation",
      ],
      3,
    ),
    startedMs: now - 10 * minute,
    costMicros: 220_000,
    asks: ["m4"],
    moved: false,
    model,
  });

  // A quick question while tasks run: answered in main, in a step.
  person("What time is it in Lisbon right now?");
  answer("It's 2:32 PM in Lisbon, an hour behind you.");

  // Main started on this itself and it ran long, so Spade moved it to a task (ADR 0217 §2a):
  // main's reply moves and closes with no words.
  const quarterlyAsk = "Draft the quarterly note from the numbers in Q3.xlsx.";
  person(quarterlyAsk);
  const quarterly = `${main}-lane-quarterly`;
  host.store(main, { type: "reply_started", reply: `r-${quarterly}`, model });
  lanes.start({
    task: quarterly,
    main,
    // A moved lane is first titled with the person's first line; the title role names it after.
    title: "Draft the quarterly note from the numbers in Q3.xlsx",
    words: quarterlyAsk,
    state: "working",
    plan: plan(
      [
        "Read Q3.xlsx",
        "Pull last quarter's note for the sections",
        "Outline the note",
        "Write the revenue section",
        "Write costs and hiring",
        "Check every number against the sheet",
      ],
      3,
    ),
    startedMs: now - 6 * minute,
    costMicros: 610_000,
    asks: ["m8"],
    moved: true,
    model,
  });
  host.store(main, { type: "reply_finished", reply: `r-${quarterly}`, text: "", cost_micros: 0 });
  lanes.retitle(quarterly, "Draft the quarterly note");

  const driveAsk = "Clean up the shared drive: one folder per client.";
  person(driveAsk);
  answer("I'll sort it into client folders. Nothing gets deleted.");
  const drive = `${main}-lane-drive`;
  lanes.start({
    task: drive,
    main,
    title: "Clean up the shared drive",
    words: driveAsk,
    state: "working",
    plan: plan(
      [
        "List every file and its client",
        "Move them into one folder per client",
        "Check nothing was left at the top",
      ],
      3,
    ),
    startedMs: now - 5 * minute,
    costMicros: 170_000,
    asks: ["m10"],
    moved: false,
    model,
  });

  const crmAsk = "And compare the three CRM quotes in /quotes.";
  person(crmAsk);
  answer("Comparing them now.");
  const crm = `${main}-lane-crm`;
  lanes.start({
    task: crm,
    main,
    title: "Compare the three CRM quotes",
    words: crmAsk,
    state: "working",
    plan: plan(
      [
        "Read the Pipedrive and Attio quotes",
        "Put them side by side in crm.md",
        "Check HubSpot's list prices",
      ],
      2,
    ),
    startedMs: now - 4 * minute,
    costMicros: 290_000,
    asks: ["m12"],
    moved: false,
    model,
  });

  // A reply to the invoice line goes to that task with no model call; the task hears it.
  const routed = "Send it to her work address, dana@northwind.co.";
  person(routed, {
    reply_to: {
      id: "m2",
      text: "On it. I'll fix the VAT line, check the totals, then send it to Dana.",
    },
  });
  host.store(main, {
    type: "ask_routed",
    lane: invoice,
    title: "Fix the March invoice",
    message: routed,
  });
  host.store(invoice, { type: "user_message", text: routed });
  host.store(invoice, {
    type: "step_finished",
    reply: `r-${invoice}`,
    text: "Got it, dana@northwind.co. Writing the email now.",
    calls: [],
  });

  lanes.settle(drive, "done", "214 files in six client folders; nothing deleted.");
  answer(
    "The shared drive is tidy: 214 files in six client folders. Nothing was deleted, and every move is listed in drive-moves.md.",
  );
  lanes.settle(crm, "failed", "HubSpot's pricing page wouldn't load after three tries");
  answer(
    "The CRM comparison stopped early: HubSpot's pricing page wouldn't load after three tries. Pipedrive and Attio are side by side in crm.md.",
  );

  // Two running tasks wrote one file: a note, never a lock (ADR 0217 §3).
  lanes.overlapped(quarterly, invoice, "finance/Q3-totals.xlsx");

  person("Then renew the domain before it lapses.");
  answer("Queued behind the running tasks; it starts when one ends.");
  lanes.start({
    task: `${main}-lane-domain`,
    main,
    title: "Renew the domain",
    words: "Then renew the domain before it lapses.",
    state: "queued",
    plan: [],
    startedMs: now - minute,
    costMicros: 0,
    asks: ["m16"],
    moved: false,
    model,
  });

  // The quarterly note asks the person; its card is asked in main too (ADR 0217 §4).
  lanes.askQuestion(
    quarterly,
    "q1",
    "Should the revenue section compare against Q2 or against Q3 last year?",
  );

  // The flights wait on the person last, so the chat ends on that request.
  lanes.ask(flights, "k1", "browser_act", {
    action: "click",
    target: "Pay €412 to TAP Air Portugal",
  });
  answer(
    "The flights are ready: TAP, out on the 14th at 9:10, back on the 18th at 18:40, window seats both ways, €412 in all. Paying needs your OK.",
  );
}
