import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeContractAskedLine,
  spadeTogether,
  spadeTogetherHeader,
  spadeTogetherLine,
  spadeTogetherRows,
  spadeTogetherState,
  spadeTogetherTranscript,
  spadeView,
  spadeWithoutWork,
  type SpadeTogetherBubble,
  type SpadeTogetherRow,
} from "./index.ts";

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: seq, event }));
    if (input) foldSpade(state, input);
  };
  return { stored, view: () => spadeView(state) };
}

type Chat = ReturnType<typeof conversation>;

/** Quill's turn `reply` sends Writing `text` as job `job`, which runs in the background. */
function sends(c: Chat, reply: string, job: string, text: string) {
  c.stored({
    type: "step_finished",
    reply,
    text: "",
    calls: [{ id: job, name: "bot_message", arguments: { bot: "writing", text } }],
  });
  c.stored({ type: "tool_started", reply, call_id: job, name: "bot_message" });
  c.stored({ type: "job_started", reply, job, name: "bot_message" });
  c.stored({ type: "tool_finished", reply, call_id: job, name: "bot_message", content: "" });
}

function answers(c: Chat, job: string, text: string) {
  c.stored({
    type: "job_finished",
    job,
    name: "bot_message",
    content: `Writing answered:\n${text}`,
  });
}

/** Quill's turn `reply` calls Flight watcher's `contract` as job `job`. */
function calls(c: Chat, reply: string, job: string, contract: string) {
  c.stored({
    type: "step_finished",
    reply,
    text: "",
    calls: [
      {
        id: job,
        name: "contract_call",
        arguments: { bot: "Flight watcher", contract, input: { from: "OPO" } },
      },
    ],
  });
  c.stored({ type: "tool_started", reply, call_id: job, name: "contract_call" });
  c.stored({ type: "job_started", reply, job, name: "contract_call" });
  c.stored({
    type: "contract_called",
    job,
    call: `cc.${job}`,
    bot: "fw",
    name: "Flight watcher",
    contract,
  });
  c.stored({ type: "tool_finished", reply, call_id: job, name: "contract_call", content: "" });
}

function returns(c: Chat, job: string, output: Record<string, unknown>) {
  c.stored({
    type: "job_finished",
    job,
    name: "contract_call",
    content: `<contract_result call="cc.${job}" status="returned">\n${JSON.stringify(output)}\n</contract_result>`,
  });
}

/** The turn cards the chat shows with Show work off. */
function cards(c: Chat): SpadeTogetherBubble[] {
  const shown = spadeWithoutWork(spadeBubbles(c.view()), { all: false, turns: new Set() });
  return spadeTogether(shown).filter(
    (bubble): bubble is SpadeTogetherBubble => bubble.kind === "together",
  );
}

const rowsOf = (card: SpadeTogetherBubble | undefined) => spadeTogetherRows(card?.parts ?? []);

/** A row as the card reads it: its other bot's name and its second line. */
function read(row: SpadeTogetherRow, phrase?: string) {
  if (row.kind === "worker") return [row.worker.name, "agent"];
  const name = row.kind === "message" ? "Writing" : row.call.bot;
  return [name, spadeTogetherLine(row, phrase).text];
}

function header(card: SpadeTogetherBubble | undefined) {
  const rows = rowsOf(card).map((row) =>
    row.kind === "worker"
      ? { name: row.worker.name, ace: row.worker.kind === "ace", state: "done" as const }
      : {
          name: row.kind === "message" ? "Writing" : row.call.bot,
          ace: false,
          state: spadeTogetherState(row),
        },
  );
  return spadeTogetherHeader("Quill", rows, { current: true, workersOnly: false });
}

describe("one turn's work with other bots, in the sender's chat", () => {
  test("is one card with Show work off, holding its messages, contract calls and agents", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Get the intro and the fare." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft the intro.");
    calls(c, "r1", "k1", "cheapest_fare");
    c.stored({
      type: "worker_started",
      worker: "t-9",
      kind: "ace",
      name: "Check the hotel",
      call: "d1",
    });
    c.stored({ type: "reply_finished", reply: "r1", text: "On it." });

    const all = cards(c);
    expect(all).toHaveLength(1);
    expect(rowsOf(all[0]).map((row) => read(row, "Drafting the intro"))).toEqual([
      ["Writing", "Drafting the intro"],
      ["Flight watcher", "Drafting the intro"],
      ["Check the hotel", "agent"],
    ]);
    expect(rowsOf(all[0]).map((row) => read(row))[1]).toEqual([
      "Flight watcher",
      "Getting the cheapest fare",
    ]);
  });

  test("each reply fills its row in plain words, and the header says whom it worked with", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Get the intro and the fare." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft the intro.");
    calls(c, "r1", "k1", "cheapest_fare");
    c.stored({ type: "reply_finished", reply: "r1", text: "On it." });
    expect(header(cards(c)[0])).toBe("Quill is working with Writing and Flight watcher");

    answers(c, "j1", "Three days on the river.\nTwo on the hills.");
    returns(c, "k1", { fare: "€78" });
    const card = cards(c)[0];
    expect(rowsOf(card).map((row) => read(row))).toEqual([
      ["Writing", "Replied: Three days on the river."],
      ["Flight watcher", "Cheapest fare: fare €78"],
    ]);
    expect(header(card)).toBe("Quill worked with Writing and Flight watcher");
  });

  test("an opened row shows the whole exchange, who said what", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Ask Writing." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft the intro.");
    answers(c, "j1", "Three days on the river.\nTwo on the hills.");
    const [row] = rowsOf(cards(c)[0]);
    expect(
      row && row.kind !== "worker"
        ? spadeTogetherTranscript(row, { self: "Quill", other: "Writing" }).map((line) => [
            line.name,
            line.text,
          ])
        : [],
    ).toEqual([
      ["Quill", "Draft the intro."],
      ["Writing", "Three days on the river.\nTwo on the hills."],
    ]);
  });

  test("three messages to the same bot in one turn are three rows of one card", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Work it out with Writing." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft the intro.");
    answers(c, "j1", "Here it is.");
    sends(c, "r1", "j2", "Shorter, please.");
    answers(c, "j2", "Shorter.");
    c.stored({ type: "step_finished", reply: "r1", text: "Nearly there." });
    sends(c, "r1", "j3", "And a title?");
    c.stored({ type: "reply_finished", reply: "r1", text: "Waiting on a title." });
    const all = cards(c);
    expect(all).toHaveLength(1);
    expect(rowsOf(all[0]).map((row) => read(row))).toEqual([
      ["Writing", "Replied: Here it is."],
      ["Writing", "Replied: Shorter."],
      ["Writing", "Working on it"],
    ]);
  });

  test("a later turn's messages are a card of their own", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Ask Writing." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft the intro.");
    c.stored({ type: "reply_finished", reply: "r1", text: "Asked." });
    c.stored({ type: "user_message", text: "And a title." });
    c.stored({ type: "reply_started", reply: "r2" });
    sends(c, "r2", "j2", "A title?");
    expect(cards(c)).toHaveLength(2);
  });

  test("a pending reply never reads finished, and keeps the bot busy after its turn ends", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Ask Writing." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft it.");
    c.stored({ type: "reply_finished", reply: "r1", text: "Asked." });
    const [row] = rowsOf(cards(c)[0]);
    expect(row && row.kind !== "worker" ? spadeTogetherState(row) : undefined).toBe("working");
    expect(row && row.kind !== "worker" ? spadeTogetherLine(row).live : undefined).toBe(true);
    expect(header(cards(c)[0])).toBe("Quill is working with Writing");
    expect(c.view().busy).toBe(true);
    answers(c, "j1", "Done.");
    expect(header(cards(c)[0])).toBe("Quill worked with Writing");
    expect(c.view().busy).toBe(false);
  });

  test("a failed message or contract call says so plainly, in the failed tone", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Ask them." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft it.");
    calls(c, "r1", "k1", "seat_map");
    c.stored({
      type: "job_finished",
      job: "j1",
      name: "bot_message",
      is_error: true,
      content: "Writing is paused.",
    });
    c.stored({
      type: "job_finished",
      job: "k1",
      name: "contract_call",
      is_error: true,
      content:
        '<contract_result call="cc.k1" status="failed">\nclosed until check-in\n</contract_result>',
    });
    const lines = rowsOf(cards(c)[0]).flatMap((row) =>
      row.kind === "worker" ? [] : [spadeTogetherLine(row)],
    );
    expect(lines).toEqual([
      { text: "Couldn't reach it: Writing is paused.", tone: "failed", live: false },
      {
        text: "Couldn't get the seat map: closed until check-in",
        tone: "failed",
        live: false,
      },
    ]);
  });
});

describe("a message from another bot, in the receiver's chat", () => {
  test("arrives as input from that bot, and a finished reply says it went back", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: "Can you draft a two-line intro?",
      from_agent: { id: "quill", name: "Quill", depth: 1 },
    });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "Launch day." });
    const said = () =>
      spadeBubbles(c.view()).map((bubble) =>
        bubble.kind === "other"
          ? ["from", bubble.agent.name, bubble.text]
          : bubble.kind === "bot"
            ? ["bot", bubble.text, bubble.repliedTo?.name]
            : [bubble.kind],
      );
    // Still being written: nothing has gone back yet.
    expect(said()).toEqual([
      ["from", "Quill", "Can you draft a two-line intro?"],
      ["bot", "Launch day.", undefined],
    ]);
    c.stored({ type: "reply_finished", reply: "r1", text: "Launch day." });
    c.stored({ type: "user_message", text: "Thanks." });
    c.stored({ type: "reply_started", reply: "r2" });
    c.stored({ type: "step_finished", reply: "r2", text: "Anytime." });
    c.stored({ type: "reply_finished", reply: "r2", text: "Anytime." });
    expect(said()).toEqual([
      ["from", "Quill", "Can you draft a two-line intro?"],
      ["bot", "Launch day.", "Quill"],
      ["person"],
      // An answer to the person goes back to no bot.
      ["bot", "Anytime.", undefined],
    ]);
  });

  test("a contract call is one compact line with what this bot returned", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: "cheapest_fare",
      from_agent: {
        id: "quill",
        name: "Quill",
        depth: 1,
        contract: { call: "cc.c1", contract: "cheapest_fare", input: { from: "KTM" } },
      },
    });
    c.stored({ type: "reply_started", reply: "r1" });
    const line = () => {
      const bubble = spadeBubbles(c.view()).find((each) => each.kind === "other");
      return bubble?.kind === "other" && bubble.contract
        ? spadeContractAskedLine(bubble.contract, { from: "Quill", working: c.view().busy })
        : undefined;
    };
    expect(line()).toEqual({
      text: "Quill asked for the cheapest fare · Working on it",
      tone: "working",
      live: true,
    });
    // A return that doesn't fit the contract is not its answer.
    c.stored({ type: "contract_misfit", call: "cc.c1", problems: ["output.fare: missing"] });
    expect(line()?.live).toBe(true);
    c.stored({
      type: "contract_ended",
      call: "cc.c1",
      status: "returned",
      output: { fare: "€78" },
      untrusted: false,
    });
    c.stored({ type: "reply_finished", reply: "r1", text: "" });
    expect(line()).toEqual({
      text: "Quill asked for the cheapest fare · fare €78",
      tone: "settled",
      live: false,
    });
  });

  test("a contract call it couldn't answer says so plainly", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: "seat_map",
      from_agent: {
        id: "quill",
        name: "Quill",
        depth: 1,
        contract: { call: "cc.c2", contract: "seat_map", input: {} },
      },
    });
    c.stored({ type: "contract_ended", call: "cc.c2", status: "failed", problems: ["closed"] });
    const bubble = spadeBubbles(c.view()).find((each) => each.kind === "other");
    expect(
      bubble?.kind === "other" && bubble.contract
        ? spadeContractAskedLine(bubble.contract, { from: "Quill", working: false })
        : undefined,
    ).toEqual({
      text: "Quill asked for the seat map · Couldn't answer: closed",
      tone: "failed",
      live: false,
    });
  });
});
