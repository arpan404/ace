import { expect, test } from "vitest";
import type { FakeSpadeAgent, FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * What Siri's Ask Spade asks of one machine's runtime (ADR 0134, amendment 2026-11-22): where
 * this machine's Spade says Spade lives, then the words sent to the main Spade and the reply
 * that answers them, if it comes in time.
 */

const mainOf = (api: FakeSpadeApi) => {
  const main = api.agents.find((agent) => agent.kind === "main");
  if (!main) throw new Error("no main bot");
  return main;
};

/** Answers the first person's message stored after `from` with `text`, once it lands. */
async function answerOnArrival(api: FakeSpadeApi, main: FakeSpadeAgent, text: string, from = 0) {
  await until(() =>
    api
      .eventsOf(main.conversation)
      .slice(from)
      .some((event) => event.type === "user_message"),
  );
  api.reply(main, text);
}

test("a machine says where Spade lives, and its main conversation", async () => {
  const { ask } = await setUp((api) => {
    api.here = "ios-test-host";
    api.hostRecord = { host: "ios-test-host", version: 3, at: 8, by: "person" };
    api.addAgent({ name: "Spade", kind: "main", created_at: 4 });
    api.addAgent({ name: "Research" });
  });

  const answer = await ask({ type: "spade.main.read" });

  expect(answer).toMatchObject({
    ok: true,
    here: "ios-test-host",
    record: { host: "ios-test-host", version: 3, at: 8, by: "person" },
    createdAt: 4,
  });
  expect(answer).toHaveProperty("conversationId");
});

test("a machine whose Spade isn't running says why instead of where", async () => {
  const { ask, spade } = await setUp((api, daemon) => {
    api.addAgent({ name: "Spade", kind: "main" });
    daemon.spade.status = { state: "off", version: "0.6.0" };
  });
  await until(() => spade.setting.status);

  const answer = await ask({ type: "spade.main.read" });

  expect(answer).toMatchObject({ ok: false, message: spade.placeSentence });
});

test("asking sends the words to the main Spade and answers with its reply", async () => {
  const { ask, api } = await setUp((fake) => fake.addAgent({ name: "Spade", kind: "main" }));
  const main = mainOf(api);
  const where = await ask({ type: "spade.main.read" });
  if (!where.ok || !("conversationId" in where)) throw new Error("no main");
  void answerOnArrival(api, main, "You have two meetings. The first is at ten.");

  const answer = await ask({
    type: "spade.ask",
    conversationId: where.conversationId,
    after: where.after,
    text: "What's on my calendar?",
    waitMs: 5_000,
  });

  expect(answer).toMatchObject({ ok: true, reply: "You have two meetings. The first is at ten." });
  expect(api.eventsOf(main.conversation)).toContainEqual(
    expect.objectContaining({ type: "user_message", text: "What's on my calendar?" }),
  );
});

test("a reply that is still coming answers none in time, and a later wait picks it up", async () => {
  const { ask, api } = await setUp((fake) => fake.addAgent({ name: "Spade", kind: "main" }));
  const main = mainOf(api);
  const where = await ask({ type: "spade.main.read" });
  if (!where.ok || !("conversationId" in where)) throw new Error("no main");

  const first = await ask({
    type: "spade.ask",
    conversationId: where.conversationId,
    after: where.after,
    text: "Book the train",
    waitMs: 300,
  });
  expect(first).toMatchObject({ ok: true, reply: null });

  api.reply(main, "Booked the 9:10.");
  const later = await ask({
    type: "spade.reply",
    conversationId: where.conversationId,
    after: where.after,
    text: "Book the train",
    waitMs: 5_000,
  });

  expect(later).toMatchObject({ ok: true, reply: "Booked the 9:10." });
});

test("an earlier reply finishing after the question isn't taken for its answer", async () => {
  const { ask, api } = await setUp((fake) => {
    const main = fake.addAgent({ name: "Spade", kind: "main" });
    fake.store(main.conversation, { type: "user_message", text: "Tidy my inbox" });
    fake.store(main.conversation, { type: "reply_started", reply: "old" });
  });
  const main = mainOf(api);
  const where = await ask({ type: "spade.main.read" });
  if (!where.ok || !("conversationId" in where)) throw new Error("no main");
  const before = api.eventsOf(main.conversation).length;
  void (async () => {
    await until(() => api.eventsOf(main.conversation).length > before);
    api.store(main.conversation, { type: "reply_finished", reply: "old", text: "Inbox tidied." });
    api.reply(main, "It's sunny.");
  })();

  const answer = await ask({
    type: "spade.ask",
    conversationId: where.conversationId,
    after: where.after,
    text: "What's the weather?",
    waitMs: 5_000,
  });

  expect(answer).toMatchObject({ ok: true, reply: "It's sunny." });
});

test("a reply that fails answers with Spade's reason", async () => {
  const { ask, api } = await setUp((fake) => fake.addAgent({ name: "Spade", kind: "main" }));
  const main = mainOf(api);
  const where = await ask({ type: "spade.main.read" });
  if (!where.ok || !("conversationId" in where)) throw new Error("no main");
  void (async () => {
    await until(() => api.eventsOf(main.conversation).some((e) => e.type === "user_message"));
    api.store(main.conversation, { type: "reply_started", reply: "r" });
    api.store(main.conversation, {
      type: "reply_failed",
      reply: "r",
      text: "",
      error: "The endpoint is out of credit.",
    });
  })();

  const answer = await ask({
    type: "spade.ask",
    conversationId: where.conversationId,
    after: where.after,
    text: "Hello",
    waitMs: 5_000,
  });

  expect(answer).toMatchObject({ ok: false, message: "The endpoint is out of credit." });
});
