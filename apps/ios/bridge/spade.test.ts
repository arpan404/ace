import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { quick, setUp } from "./spade-test-host.ts";
import type { NativeSpadeRequest } from "./spade-requests.ts";
import type { SpadeBubbleRow } from "./spade-rows.ts";

/*
 * Spade on the iPhone over the real SDK and an in-process fake daemon with a fake Spade behind
 * `spade.*`: whether the tab shows, the bots in the list's order and words, and one
 * conversation live, sending, answering and stopping as Swift asks.
 */

test("the Spade tab shows while Beta's switch is on, and goes the moment it is turned off", async () => {
  const { daemon, patches } = await setUp();
  await until(() => patches.state?.shown === true);

  daemon.spade.setStatus({ state: "off", hidden: true });

  await until(() => patches.state?.shown === false);
});

test("with the Spade tab away, a bot starting or ending work still shows, at the slower pace", async () => {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const { api, patches } = await setUp((fake) => {
    bot = fake.addAgent({ name: "Research" });
  }, quick);
  if (!bot) throw new Error("no bot");
  const research = () => patches.state?.list.rows?.find((row) => row.name === "Research");
  await until(() => research()?.state === "rest");

  api.status(bot, "working", "Reading the notes");
  await until(() => research()?.state === "working");

  api.status(bot, "idle", null);
  await until(() => research()?.state === "rest");
});

/** Waits long enough for several reads at the quick away pace. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 1_000));

test("while the app isn't active the bots aren't read, and they are read the moment it is", async () => {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const { api, patches, spade } = await setUp((fake) => {
    bot = fake.addAgent({ name: "Research" });
  }, quick);
  if (!bot) throw new Error("no bot");
  const research = () => patches.state?.list.rows?.find((row) => row.name === "Research");
  await until(() => research()?.state === "rest");

  spade.handle({ type: "spade.active", active: false });
  const reads = api.sent("GET", "/v1/agents").length;
  api.status(bot, "working", "Reading the notes");
  await quiet();
  expect(api.sent("GET", "/v1/agents").length).toBe(reads);
  expect(research()?.state).toBe("rest");

  spade.handle({ type: "spade.active", active: true });
  await until(() => research()?.state === "working");
});

test("the list puts Spade first, then whoever needs the person, then working, then the rest", async () => {
  const { patches, spade } = await setUp((api) => {
    api.addAgent({ name: "Quiet", last_activity: 50, last_message: lastWords("All done.") });
    api.addAgent({ name: "Busy", state: "working", status: "Reading the docs", last_activity: 10 });
    api.addAgent({ name: "Spade", kind: "main", last_activity: 1 });
    api.addAgent({ name: "Asker", state: "waiting", waiting_for: "approval", last_activity: 5 });
  });
  spade.handle({ type: "spade.watch", on: true });

  const rows = await until(() => patches.state?.list.rows ?? undefined);

  expect(rows.map((row) => [row.name, row.state, row.line])).toEqual([
    ["Spade", "rest", "No messages yet"],
    ["Asker", "needs-you", "Needs you"],
    ["Busy", "working", "Reading the docs"],
    ["Quiet", "rest", "All done."],
  ]);
  expect(rows[0]?.main).toBe(true);
});

test("while Spade isn't running the tab says why, and no bot shows as still working", async () => {
  const { daemon, patches, spade } = await setUp((api) =>
    api.addAgent({ name: "Busy", state: "working", status: "Reading" }),
  );
  spade.handle({ type: "spade.watch", on: true });
  await until(() => patches.state?.list.rows?.[0]?.state === "working");

  daemon.spade.setStatus({ state: "failed", reason: "It exited with code 1." });

  await until(() => patches.state?.line.sentence === "Spade stopped. It exited with code 1.");
  expect(patches.state?.line.ready).toBe(false);
  await until(() => patches.state?.list.rows?.[0]?.state === "off");
});

test("an open conversation shows its history, then a reply's words as they stream in", async () => {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const { api, daemon, patches, spade } = await setUp((fake) => {
    bot = fake.addAgent({ name: "Helper" });
    fake.store(bot.conversation, { type: "user_message", text: "Plan my week" });
    fake.reply(bot, "Here is a plan.");
  });
  if (!bot) throw new Error("no bot");
  spade.handle({ type: "spade.open", conversationId: bot.conversation });

  await until(() => patches.bubbles.length === 2);
  expect(patches.bubbles).toEqual([
    { kind: "person", text: "Plan my week", sending: false, attached: null },
    { kind: "bot", text: "Here is a plan.", live: false, end: null },
  ]);

  api.store(bot.conversation, { type: "reply_started", reply: "r9" });
  daemon.spade.emit(`/v1/conversations/${bot.conversation}/live`, "delta", {
    reply: "r9",
    text: "Thinking it",
  });

  await until(() => patches.bubbles.at(-1)?.kind === "bot" && patches.bubbles.length === 3);
  expect(patches.bubbles.at(-1)).toEqual({
    kind: "bot",
    text: "Thinking it",
    live: true,
    end: null,
  });
  expect(patches.head).toMatchObject({ answering: true, loaded: true, problem: null });
});

test("a sent message shows at once, and stays once Spade has stored it", async () => {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const { api, patches, spade, ask } = await setUp((fake) => {
    bot = fake.addAgent({ name: "Helper" });
  });
  if (!bot) throw new Error("no bot");
  spade.handle({ type: "spade.open", conversationId: bot.conversation });
  await until(() => patches.head?.loaded === true);

  const sending = ask({ type: "spade.send", conversationId: bot.conversation, text: "Hello" });
  expect(patches.bubbles).toEqual([
    { kind: "person", text: "Hello", sending: true, attached: null },
  ]);

  expect(await sending).toEqual({ ok: true });
  await until(() => patches.bubbles[0]?.kind === "person" && !patches.bubbles[0].sending);
  expect(patches.bubbles).toHaveLength(1);
  expect(api.sent("POST", `/v1/conversations/${bot.conversation}/messages`)).toEqual([
    { text: "Hello" },
  ]);
});

test("a message Spade refuses leaves the conversation, and the phone is told why", async () => {
  const { patches, spade, ask } = await setUp();
  spade.handle({ type: "spade.open", conversationId: "c-gone" });

  const outcome = await ask({ type: "spade.send", conversationId: "c-gone", text: "Hello" });

  expect(outcome).toMatchObject({ ok: false, title: "Couldn't send" });
  expect(patches.bubbles).toEqual([]);
});

test("an approval shows in Spade's words with Always allow where it holds, and Allow answers it", async () => {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const { api, patches, spade, ask } = await setUp((fake) => {
    bot = fake.addAgent({ name: "Builder" });
    fake.ask(bot, "call-1", "shell", { command: "npm test" });
  });
  if (!bot) throw new Error("no bot");
  spade.handle({ type: "spade.open", conversationId: bot.conversation });

  // Named once the list says whose conversation it is.
  const card = await until(() =>
    patches.bubbles.find((row) => row.kind === "ask" && row.sentence.startsWith("Builder")),
  );
  expect(card).toMatchObject({
    callId: "call-1",
    sentence: "Builder wants to run a command.",
    detail: "npm test",
    always: true,
  });

  const answered = await ask({
    type: "spade.answer",
    conversationId: bot.conversation,
    callId: "call-1",
    allowed: true,
    always: false,
  });

  expect(answered).toEqual({ ok: true });
  expect(api.sent("POST", `/v1/conversations/${bot.conversation}/approvals/call-1`)).toEqual([
    { allowed: true, always: false },
  ]);
  await until(() => !patches.bubbles.some((row) => row.kind === "ask"));
});

test("Stop ends the open reply, and a Stop that finds nothing answering is no failure", async () => {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const { api, patches, spade, ask } = await setUp((fake) => {
    bot = fake.addAgent({ name: "Helper" });
    fake.store(bot.conversation, { type: "reply_started", reply: "r1" });
  });
  if (!bot) throw new Error("no bot");
  spade.handle({ type: "spade.open", conversationId: bot.conversation });
  await until(() => patches.head?.answering === true);

  expect(await ask({ type: "spade.stop", conversationId: bot.conversation })).toEqual({ ok: true });

  await until(() => patches.head?.answering === false);
  expect(patches.bubbles.at(-1)).toMatchObject({ kind: "bot", end: { text: "Stopped" } });
  expect(api.sent("POST", `/v1/conversations/${bot.conversation}/stop`)).toHaveLength(1);
});

test("opening a conversation Spade counts unseen marks it seen, and its row settles", async () => {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const { patches, spade } = await setUp((fake) => {
    bot = fake.addAgent({ name: "Helper", unseen: true });
    fake.reply(bot, "Done.");
    bot.unseen = true;
  });
  if (!bot) throw new Error("no bot");
  spade.handle({ type: "spade.watch", on: true });
  await until(() => patches.state?.list.rows?.[0]?.state === "unseen");

  spade.handle({ type: "spade.open", conversationId: bot.conversation });

  await until(() => patches.state?.list.rows?.[0]?.state === "rest");
});

/** A bot waiting on a card of questions (ADR 0154), opened on the phone. */
async function asked(questions: Record<string, unknown>[]) {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const set = await setUp((fake) => {
    bot = fake.addAgent({ name: "Planner" });
    fake.card(bot, "q1", questions);
  });
  if (!bot) throw new Error("no bot");
  const conversation = bot.conversation;
  set.spade.handle({ type: "spade.open", conversationId: conversation });
  const card = () =>
    set.patches.bubbles.find(
      (row): row is Extract<SpadeBubbleRow, { kind: "question" }> => row.kind === "question",
    );
  await until(() => card()?.label.startsWith("Planner"));
  const reply = (body: Extract<NativeSpadeRequest, { type: "spade.question" }>["reply"]) =>
    set.ask({ type: "spade.question", conversationId: conversation, callId: "q1", reply: body });
  const posted = () => set.api.sent("POST", `/v1/conversations/${conversation}/questions/q1`);
  return { ...set, card, reply, posted, conversation };
}

const trip = [
  {
    prompt: "Where to?",
    kind: "choice",
    options: ["Lisbon", { label: "Porto", detail: "By train" }],
  },
  { prompt: "How many nights?", kind: "number", min: 1, max: 14, unit: "nights" },
];

test("a card of questions waits with each question's inputs, and its answers settle it in the person's words", async () => {
  const { card, reply, posted } = await asked(trip);

  expect(card()).toMatchObject({
    standing: "open",
    label: "Planner asks 2 questions",
    questions: [
      {
        prompt: "Where to?",
        kind: "choice",
        options: [
          { label: "Lisbon", detail: null },
          { label: "Porto", detail: "By train" },
        ],
        other: false,
      },
      { prompt: "How many nights?", kind: "number", unit: "nights" },
    ],
  });

  const sent = await reply({
    drafts: [
      { kind: "picks", picked: ["Porto"], other: "" },
      { kind: "field", text: "3" },
    ],
  });

  expect(sent).toEqual({ ok: true });
  expect(posted()).toEqual([{ answers: ["Porto", 3] }]);
  await until(() => card()?.standing === "settled");
  expect(card()).toMatchObject({ answers: ["Porto", "3 nights"], line: null, closed: false });
});

test("a card whose settling update was missed settles once the phone reads it back", async () => {
  const { card, reply, ask, api, conversation } = await asked(trip);
  api.missQuestionSettles = true;

  expect(
    await reply({
      drafts: [
        { kind: "picks", picked: ["Porto"], other: "" },
        { kind: "field", text: "3" },
      ],
    }),
  ).toEqual({ ok: true });
  // Spade stored the answer, but the live stream never said so.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(card()?.standing).toBe("open");

  expect(
    await ask({ type: "spade.question.read", conversationId: conversation, callId: "q1" }),
  ).toEqual({
    ok: true,
  });
  await until(() => card()?.standing === "settled");
  expect(card()).toMatchObject({ answers: ["Porto", "3 nights"] });
});

test("a card whose reply finished unanswered is closed, not settled by its own word", async () => {
  let conversation = "";
  const set = await setUp((fake) => {
    const bot = fake.addAgent({ name: "Planner" });
    conversation = bot.conversation;
    fake.store(conversation, { type: "reply_started", reply: "r-q" });
    fake.store(conversation, {
      type: "question_asked",
      reply: "r-q",
      call_id: "q1",
      question: "Which colour?",
      questions: [{ prompt: "Which colour?" }],
    });
  });
  set.spade.handle({ type: "spade.open", conversationId: conversation });
  const card = () =>
    set.patches.bubbles.find(
      (row): row is Extract<SpadeBubbleRow, { kind: "question" }> => row.kind === "question",
    );
  await until(() => card()?.standing === "open");
  expect(card()?.closed).toBe(false);

  // Spade may have left it for later in an update the phone missed: the phone keeps its draft.
  set.api.store(conversation, { type: "reply_finished", reply: "r-q", text: "" });
  await until(() => card()?.standing === "settled");
  expect(card()).toMatchObject({ closed: true, line: "Not answered" });
});

test("a card missing an answer never reaches Spade and names the question that needs it", async () => {
  const { reply, posted, api } = await asked(trip);

  expect(
    await reply({
      drafts: [
        { kind: "picks", picked: ["Lisbon"], other: "" },
        { kind: "field", text: "30" },
      ],
    }),
  ).toEqual({ ok: false, title: "", message: "At most 14.", at: 1 });
  expect(posted()).toEqual([]);

  // Spade has the last word, and its refusal turns the card to the question it names.
  api.refuseQuestion = { status: 400, error: "Question 2: at most 14 nights." };
  expect(
    await reply({
      drafts: [
        { kind: "picks", picked: ["Lisbon"], other: "" },
        { kind: "field", text: "4" },
      ],
    }),
  ).toMatchObject({ ok: false, at: 1 });
});

test("a number the phone couldn't read in its keyboard's locale is asked for again, never guessed at", async () => {
  const { reply, posted } = await asked(trip);

  // `1.500` on a German keyboard: 1500 or 1.5, so the phone sends it unread.
  expect(
    await reply({
      drafts: [
        { kind: "picks", picked: ["Lisbon"], other: "" },
        { kind: "field", text: "1.500", unread: true },
      ],
    }),
  ).toEqual({ ok: false, title: "", message: "Enter a number.", at: 1 });
  expect(posted()).toEqual([]);
});

test("a malformed pick count still reaches the phone as a whole count it can read", async () => {
  const { card } = await asked([
    { prompt: "Which two?", kind: "choices", options: ["A", "B", "C"], max: 2.5 },
    { prompt: "Any of these?", kind: "choices", options: ["A", "B"], other: true, max: 1e300 },
  ]);

  expect(card()?.questions.map((question) => question.most)).toEqual([2, 3]);
});

test("a number that may be below zero asks for a keypad with a minus sign", async () => {
  const { card } = await asked([
    { prompt: "How cold?", kind: "number", min: -20, max: -1 },
    { prompt: "Any number?", kind: "number" },
    { prompt: "How many nights?", kind: "number", min: 1 },
    { prompt: "From zero?", kind: "number", min: 0 },
  ]);

  expect(card()?.questions.map((question) => question.signed)).toEqual([true, true, false, false]);
});

test("Answer later folds the card and the top bar counts it; Never mind then settles it as dismissed", async () => {
  const { card, reply, posted, patches } = await asked([{ prompt: "Which colour?" }]);

  expect(await reply({ defer: true })).toEqual({ ok: true });

  await until(() => card()?.standing === "later");
  expect(patches.head).toMatchObject({
    later: { words: "1 question for later", callId: "q1" },
  });

  expect(await reply({ dismiss: true })).toEqual({ ok: true });

  await until(() => card()?.standing === "settled");
  expect(card()).toMatchObject({ answers: null, line: "Dismissed" });
  expect(patches.head).toMatchObject({ later: null });
  expect(posted()).toEqual([{ defer: true }, { dismiss: true }]);
});

function lastWords(text: string) {
  return { from: "agent" as const, text, at: 50, from_agent: null };
}
