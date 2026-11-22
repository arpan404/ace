import { expect, test } from "vitest";
import type { FakeSpadeAgent, FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { memoryKeep, quick, setUp } from "./spade-test-host.ts";
import type { SpadeKeep } from "./spade-kept-events.ts";

/*
 * A Spade conversation opened again, in this run or after a launch: it shows from the events the
 * phone kept before Spade answers, reads only what came after them, and nothing kept reads as
 * still going or done until Spade has answered.
 */

/** `exchanges` messages and their whole replies: four stored events each. */
function converse(api: FakeSpadeApi, bot: FakeSpadeAgent, exchanges: number, from = 0) {
  for (let index = from; index < from + exchanges; index++) {
    api.store(bot.conversation, { type: "user_message", text: `Question ${index}` });
    api.reply(bot, `Answer ${index}`);
  }
}

/**
 * One launch of the app on a machine whose Spade holds `history`: the bot's conversation, and
 * history reads held back while `hold` is set, as a slow relay holds them.
 */
async function launch(keep: SpadeKeep, history: (api: FakeSpadeApi, bot: FakeSpadeAgent) => void) {
  let bot: FakeSpadeAgent | undefined;
  const held: (() => void)[] = [];
  const gate = { hold: false };
  const host = await setUp(
    (api) => {
      bot = api.addAgent({ name: "Research" });
      history(api, bot);
      const answer = api.answer.bind(api);
      api.answer = (request) => {
        if (!gate.hold || !request.path.includes("/events?")) return answer(request);
        return new Promise((resolve) => held.push(() => resolve(answer(request))));
      };
    },
    quick,
    { keep },
    // Both launches' Spade holds the same history, stamped alike.
    () => 1_000,
  );
  if (!bot) throw new Error("no bot");
  const reads = () => host.api.sentPaths("GET", /\/events\?/);
  const release = () => {
    gate.hold = false;
    for (const go of held.splice(0)) go();
  };
  return { ...host, bot, gate, reads, release };
}

const texts = (rows: readonly { kind: string; text?: string }[]) =>
  rows.flatMap((row) => (row.kind === "person" || row.kind === "bot" ? [row.text] : []));

test("an 800-event conversation kept from the last launch shows at once and reads only its tail", async () => {
  const keep = memoryKeep();
  const first = await launch(keep, (api, bot) => converse(api, bot, 200));
  first.spade.handle({ type: "spade.open", conversationId: first.bot.conversation });
  await until(() => (first.patches.bubbles.length === 400 ? true : undefined));
  // Spade pages the history: five reads before anything showed.
  expect(first.reads()).toHaveLength(5);
  first.spade.stop();

  const next = await launch(keep, (api, bot) => converse(api, bot, 201));
  next.gate.hold = true;
  next.spade.handle({ type: "spade.open", conversationId: next.bot.conversation });

  // The last screen shows before Spade has answered a single read.
  const kept = await until(() =>
    next.patches.bubbles.length === 400 ? next.patches.bubbles : undefined,
  );
  expect(texts(kept).slice(-2)).toEqual(["Question 199", "Answer 199"]);
  expect(next.patches.head).toMatchObject({ loaded: true, answering: false, working: null });

  next.release();
  const fresh = await until(() =>
    next.patches.bubbles.length === 402 ? next.patches.bubbles : undefined,
  );
  expect(next.reads()).toEqual([
    `/v1/conversations/${next.bot.conversation}/events?after=799&limit=200`,
  ]);
  // The tail lands after the kept rows, each once.
  expect(texts(fresh).slice(-4)).toEqual([
    "Question 199",
    "Answer 199",
    "Question 200",
    "Answer 200",
  ]);
  expect(new Set(next.patches.held.get("spade:order")?.order as string[]).size).toBe(402);
  // What it keeps for the next launch is the whole history, the tail after the kept events.
  next.spade.stop();
  const saved = JSON.parse(keep.held.get(`spade-events/${next.bot.conversation}`) ?? "[]");
  expect(saved.map((stored: { seq: number }) => stored.seq)).toEqual(
    Array.from({ length: 804 }, (_, index) => index + 1),
  );
});

test("a conversation opened again in the same run shows in the same frame", async () => {
  const keep = memoryKeep();
  const host = await launch(keep, (api, bot) => converse(api, bot, 3));
  const open = () =>
    host.spade.handle({ type: "spade.open", conversationId: host.bot.conversation });
  open();
  await until(() => (host.patches.bubbles.length === 6 ? true : undefined));
  host.spade.handle({ type: "spade.open", conversationId: null });
  converse(host.api, host.bot, 1, 3);

  open();

  expect(texts(host.patches.bubbles)).toHaveLength(6);
  await until(() => (host.patches.bubbles.length === 8 ? true : undefined));
  expect(host.reads().at(-1)).toBe(
    `/v1/conversations/${host.bot.conversation}/events?after=11&limit=200`,
  );
});

/** A reply open on an approval, with words written: as Spade stores one still going. */
function writing(api: FakeSpadeApi, bot: FakeSpadeAgent) {
  converse(api, bot, 2);
  api.store(bot.conversation, { type: "user_message", text: "And then?" });
  api.ask(bot, "call-1", "shell", { command: "ls" }, "open");
  api.store(bot.conversation, { type: "step_finished", reply: "open", text: "Halfway" });
}

test("a reply kept while it was being written reads as neither going nor done until Spade answers", async () => {
  const keep = memoryKeep();

  const first = await launch(keep, writing);
  first.spade.handle({ type: "spade.open", conversationId: first.bot.conversation });
  await until(() => (first.patches.head?.answering === true ? true : undefined));
  await until(() => (first.patches.bubbles.some((row) => row.kind === "ask") ? true : undefined));
  first.spade.stop();

  const next = await launch(keep, writing);
  next.gate.hold = true;
  next.spade.handle({ type: "spade.open", conversationId: next.bot.conversation });

  const kept = await until(() =>
    next.patches.bubbles.some((row) => row.kind === "bot" && row.text === "Halfway")
      ? next.patches.bubbles
      : undefined,
  );
  expect(next.patches.head).toMatchObject({ answering: false, working: null });
  expect(kept.some((row) => row.kind === "ask")).toBe(false);
  expect(kept.some((row) => row.kind === "bot" && row.live)).toBe(false);

  next.release();
  await until(() => (next.patches.head?.answering === true ? true : undefined));
  await until(() => (next.patches.bubbles.some((row) => row.kind === "ask") ? true : undefined));
});
