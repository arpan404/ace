import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeContractAskedCard,
  spadeTalkCard,
  spadeView,
  spadeWithoutWork,
  type SpadeBubble,
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

/** What the chat shows with Show work off. */
const shown = (c: Chat) =>
  spadeWithoutWork(spadeBubbles(c.view()), { all: false, turns: new Set() });

const names = { self: "Quill", other: "Writing" };

function talkCards(c: Chat) {
  return shown(c).flatMap((bubble) =>
    bubble.kind === "talk" ? [spadeTalkCard({ ...bubble, kind: "talk" }, names)] : [],
  );
}

const rowTexts = (card: { rows: readonly { text: string }[] }) => card.rows.map((row) => row.text);

describe("a message to another bot, in the sender's chat", () => {
  test("shows as a card even with Show work off, and the reply fills its row", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Get Writing to draft the intro." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Can you draft a two-line intro for the launch post?");
    c.stored({ type: "step_finished", reply: "r1", text: "Asked Writing." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Asked Writing." });

    expect(talkCards(c)).toMatchObject([
      {
        header: "Quill asked Writing",
        pending: true,
        rows: [
          { text: "Can you draft a two-line intro for the launch post?", from: "self" },
          { text: "Writing is working on it", from: "other", live: true },
        ],
      },
    ]);

    answers(c, "j1", "Launch day: everything you asked for, nothing you didn't.");
    const [card] = talkCards(c);
    expect(card?.pending).toBe(false);
    expect(card?.rows[1]).toMatchObject({
      from: "other",
      text: "Launch day: everything you asked for, nothing you didn't.",
      live: false,
    });
  });

  test("uses the other bot's live phrase while it works", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Ask Writing." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft it.");
    const bubble = shown(c).find((each) => each.kind === "talk");
    const card =
      bubble?.kind === "talk"
        ? spadeTalkCard({ ...bubble, kind: "talk" }, { ...names, otherPhrase: "Reading the brief" })
        : undefined;
    expect(card?.rows[1]?.text).toBe("Reading the brief");
  });

  test("three messages to the same bot in one turn fold into one card", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Work it out with Writing." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft the intro.");
    answers(c, "j1", "Here it is.");
    sends(c, "r1", "j2", "Shorter, please.");
    answers(c, "j2", "Shorter.");
    sends(c, "r1", "j3", "And a title?");
    c.stored({ type: "reply_finished", reply: "r1", text: "Waiting on a title." });

    const cards = talkCards(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.header).toBe("Quill is talking with Writing · 3 messages");
    expect(rowTexts(cards[0] ?? { rows: [] })).toEqual([
      "Draft the intro.",
      "Here it is.",
      "Shorter, please.",
      "Shorter.",
      "And a title?",
      "Writing is working on it",
    ]);
    answers(c, "j3", "“Nothing you didn't”.");
    expect(talkCards(c)[0]?.header).toBe("Quill talked with Writing · 3 messages");
  });

  test("a pending reply never reads finished, and keeps the bot busy after its turn ends", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Ask Writing." });
    c.stored({ type: "reply_started", reply: "r1" });
    sends(c, "r1", "j1", "Draft it.");
    c.stored({ type: "reply_finished", reply: "r1", text: "Asked." });
    const [card] = talkCards(c);
    expect(card?.pending).toBe(true);
    expect(card?.rows.some((row) => row.live)).toBe(true);
    expect(c.view().busy).toBe(true);
    answers(c, "j1", "Done.");
    expect(talkCards(c)[0]?.pending).toBe(false);
    expect(c.view().busy).toBe(false);
  });

  test("a failed or stopped message says so plainly", () => {
    const failed = conversation();
    failed.stored({ type: "user_message", text: "Ask Writing." });
    failed.stored({ type: "reply_started", reply: "r1" });
    sends(failed, "r1", "j1", "Draft it.");
    failed.stored({
      type: "job_finished",
      job: "j1",
      name: "bot_message",
      is_error: true,
      content: "Writing is paused.",
    });
    expect(talkCards(failed)[0]?.rows[1]).toMatchObject({
      text: "Didn't reach Writing · Writing is paused.",
      tone: "failed",
    });

    const stopped = conversation();
    stopped.stored({ type: "user_message", text: "Ask Writing." });
    stopped.stored({ type: "reply_started", reply: "r1" });
    sends(stopped, "r1", "j1", "Draft it.");
    stopped.stored({ type: "stop_requested", reply: null, jobs: ["j1"] });
    stopped.stored({
      type: "job_finished",
      job: "j1",
      name: "bot_message",
      is_error: true,
      content: "Stopped by the person before it finished.",
    });
    expect(talkCards(stopped)[0]?.rows[1]?.text).toBe("Stopped before Writing answered");
    expect(talkCards(stopped)[0]?.pending).toBe(false);
  });
});

describe("a message from another bot, in the receiver's chat", () => {
  test("arrives from that bot, and the reply is marked as going back to it", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: "Can you draft a two-line intro?",
      from_agent: { id: "quill", name: "Quill", depth: 1 },
    });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "Launch day: nothing you didn't." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Launch day: nothing you didn't." });
    c.stored({ type: "user_message", text: "Thanks, that's all." });
    c.stored({ type: "reply_started", reply: "r2" });
    c.stored({ type: "step_finished", reply: "r2", text: "Anytime." });
    c.stored({ type: "reply_finished", reply: "r2", text: "Anytime." });

    const said = shown(c).map((bubble: SpadeBubble) =>
      bubble.kind === "other"
        ? ["from", bubble.agent.name, bubble.text]
        : bubble.kind === "bot"
          ? ["bot", bubble.to?.name, bubble.text]
          : [bubble.kind],
    );
    expect(said).toEqual([
      ["from", "Quill", "Can you draft a two-line intro?"],
      ["bot", "Quill", "Launch day: nothing you didn't."],
      ["person"],
      // An answer to the person goes to no bot.
      ["bot", undefined, "Anytime."],
    ]);
  });

  test("a contract call reads as the caller asking, with what this bot returned", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: 'cheapest_fare: {"from":"KTM"}',
      from_agent: {
        id: "quill",
        name: "Quill",
        depth: 1,
        contract: { call: "cc.c1.j1", contract: "cheapest_fare", input: { from: "KTM" } },
      },
    });
    c.stored({ type: "reply_started", reply: "r1" });
    const asked = () => {
      const bubble = shown(c).find((each) => each.kind === "other");
      return bubble?.kind === "other" && bubble.contract
        ? spadeContractAskedCard(bubble.contract, {
            from: "Quill",
            self: "Flight watcher",
            working: c.view().busy,
          })
        : undefined;
    };
    expect(asked()).toMatchObject({
      header: "Quill asked for cheapest fare",
      pending: true,
      rows: [{ text: "from KTM" }, { text: "Flight watcher is working on it", live: true }],
    });
    // A return that doesn't fit the contract is not its answer.
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "k1", name: "contract_return", arguments: { call: "cc.c1.j1", output: {} } }],
    });
    c.stored({ type: "contract_misfit", call: "cc.c1.j1", problems: ["output.fare: missing"] });
    expect(asked()?.pending).toBe(true);
    c.stored({
      type: "contract_ended",
      call: "cc.c1.j1",
      status: "returned",
      output: { fare: "$182", currency: "USD" },
      untrusted: false,
    });
    c.stored({ type: "reply_finished", reply: "r1", text: "" });
    expect(asked()).toMatchObject({
      pending: false,
      rows: [{ text: "from KTM" }, { text: "fare $182 · currency USD", from: "self" }],
    });
    // Its answer went back as the return, not as words to Quill.
    expect(shown(c).some((bubble) => bubble.kind === "bot" && bubble.to)).toBe(false);
  });

  test("a contract call it couldn't answer says so plainly", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: "cheapest_fare",
      from_agent: {
        id: "quill",
        name: "Quill",
        depth: 1,
        contract: { call: "cc.c2", contract: "cheapest_fare", input: { from: "KTM" } },
      },
    });
    c.stored({
      type: "contract_ended",
      call: "cc.c2",
      status: "failed",
      problems: ["output.fare: is a number"],
    });
    const bubble = shown(c).find((each) => each.kind === "other");
    const card =
      bubble?.kind === "other" && bubble.contract
        ? spadeContractAskedCard(bubble.contract, {
            from: "Quill",
            self: "Flight watcher",
            working: false,
          })
        : undefined;
    expect(card?.pending).toBe(false);
    expect(card?.rows.at(-1)).toMatchObject({
      text: "Couldn't answer · output.fare: is a number",
      tone: "failed",
    });
  });
});
