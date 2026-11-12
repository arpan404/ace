import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, FakeSpadeApi, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { spadeUnconfirmedBotNote } from "@ace/ui-core/spade-chat";
import { NativeSpade } from "./spade.ts";
import { answerSpade, type NativeSpadeRequest } from "./spade-requests.ts";

/*
 * Spade on the phone over the real SDK and the in-process fake daemon's Spade (ADR 0127): what
 * the Spade place says, its roster of bots, one bot's conversation streaming live as bubbles,
 * and the requests the phone makes.
 */

const clients: ClientCore[] = [];
const spades: NativeSpade[] = [];
afterEach(async () => {
  for (const spade of spades.splice(0)) spade.stop();
  await Promise.all(clients.splice(0).map((owner) => owner.close()));
});

/** A pump stand-in that keeps the latest patch per key, as Swift ends up holding them. */
function sink() {
  const pending = new Map<string, () => Record<string, unknown> | undefined>();
  const held = new Map<string, Record<string, unknown>>();
  const puts = new Map<string, number>();
  return {
    put(key: string, read: () => Record<string, unknown> | undefined) {
      pending.set(key, read);
    },
    clear(prefix: string) {
      for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
      for (const key of held.keys()) if (key.startsWith(prefix)) held.delete(key);
    },
    /** What Swift holds once every queued patch has been sent. */
    flush() {
      for (const [key, read] of pending) {
        const patch = read();
        if (patch) held.set(key, patch);
        puts.set(key, (puts.get(key) ?? 0) + 1);
      }
      pending.clear();
      return held;
    },
    puts,
  };
}

/** Timers past one frame wait for the test (`fire`); a frame runs at once. */
function clock() {
  const waiting: { delay: number; run: () => void }[] = [];
  return {
    later(delay: number, run: () => void) {
      if (delay <= 16) {
        const timer = setTimeout(run, 0);
        return () => clearTimeout(timer);
      }
      const entry = { delay, run };
      waiting.push(entry);
      return () => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
      };
    },
    fire(delay: number) {
      for (const entry of waiting.filter((item) => item.delay === delay)) {
        waiting.splice(waiting.indexOf(entry), 1);
        entry.run();
      }
    },
  };
}

async function phone(setup: (api: FakeSpadeApi, daemon: FakeDaemon) => void = () => {}) {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: "studio", token: "ios-test-token" });
  daemon.spade.status = { state: "ready", version: "0.6.0" };
  const api = new FakeSpadeApi(daemon.spade, () => 1_800_000_000_000);
  setup(api, daemon);
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-spade-test"),
    expectedHostId: HostId.parse(daemon.hostId),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  clients.push(owner);
  await owner.start();
  await until(() => owner.state === "ready");
  const patches = sink();
  const timers = clock();
  const deps = { now: () => 1_800_000_100_000, id: () => crypto.randomUUID(), later: timers.later };
  const spade = new NativeSpade(owner, patches, deps);
  spades.push(spade);
  const ask = (request: NativeSpadeRequest) =>
    answerSpade(owner, spade, request, deps, new AbortController().signal);
  return { daemon, api, spade, patches, timers, ask };
}

type Held = Map<string, Record<string, unknown>>;
interface RosterRow {
  id: string;
  name: string;
  main: boolean;
  line: string;
  tone: string | null;
  face: { kind: string };
}
const state = (held: Held) =>
  held.get("spade:state") as
    | {
        line: { sentence: string; ready: boolean; canTurnOn: boolean };
        enabled: boolean | null;
        roster: { rows: RosterRow[] | null };
      }
    | undefined;
const conversation = (held: Held) =>
  held.get("spade:conversation") as
    | {
        agentId: string;
        loaded: boolean;
        problem: string | null;
        busy: boolean;
        status: { text: string; moving: boolean } | null;
      }
    | undefined;
/** The open conversation's bubbles in order, as Swift lays them out. */
function bubbles(held: Held) {
  const order = (held.get("spade:order")?.order as string[] | undefined) ?? [];
  return order.map((key) => held.get(`spade:bubble:${key}`)?.row as Record<string, unknown>);
}
const texts = (held: Held) => bubbles(held).map((row) => row?.text);

/** A bot of the fake Spade, and the action that opens its conversation on the phone. */
function opening(api: FakeSpadeApi, name: string) {
  const agent = api.agents.find((candidate) => candidate.name === name);
  if (!agent) throw new Error(`no bot ${name}`);
  return {
    agent,
    action: {
      type: "spade.open" as const,
      bot: { agentId: agent.id, conversationId: agent.conversation },
    },
  };
}

test("with Spade off the place says so and offers Turn on, and Turn on saves the setting", async () => {
  const { daemon, spade, patches, ask } = await phone((_api, fake) => {
    fake.spade.status = { state: "off" };
  });
  await ask({ type: "spade.enable", on: false });
  spade.handle({ type: "spade.watch", on: true });
  await until(() => state(patches.flush())?.enabled === false);
  expect(state(patches.flush())?.line).toEqual({
    sentence: "Spade is off.",
    ready: false,
    canTurnOn: true,
  });

  expect(await ask({ type: "spade.enable", on: true })).toEqual({ ok: true });
  daemon.spade.setStatus({ state: "starting" });
  await until(() => state(patches.flush())?.enabled === true);
  expect(state(patches.flush())?.line.sentence).toBe("Spade is starting.");
});

test("the roster lists Spade first, says what each bot does now, and reads again on its own", async () => {
  const { api, spade, patches, timers } = await phone((fake) => {
    fake.addAgent({ id: "spade", kind: "main", name: "Spade", last_activity: 1 });
    fake.addAgent({
      name: "Mailer",
      last_activity: 5,
      state: "waiting",
      waiting_for: "approval",
      status: null,
    });
    fake.addAgent({
      name: "Scout",
      last_activity: 9,
      last_message: { from: "agent", text: "Found three flats.", at: 9, from_agent: null },
    });
  });
  spade.handle({ type: "spade.watch", on: true });
  const listed = await until(() => state(patches.flush())?.roster.rows ?? undefined);
  expect(listed.map((row) => [row.name, row.line, row.tone])).toEqual([
    ["Spade", "No messages yet", null],
    ["Scout", "Found three flats.", null],
    ["Mailer", "Waiting for you", "needs-you"],
  ]);
  expect(listed[0]?.face).toEqual({ kind: "spade" });

  // A bot that isn't idle has the roster read again soon; a new bot shows on that read.
  api.addAgent({ name: "Planner", last_activity: 20 });
  timers.fire(2_000);
  await until(() => state(patches.flush())?.roster.rows?.length === 4);
  expect(state(patches.flush())?.roster.rows?.[1]?.name).toBe("Planner");
});

test("a bot's conversation shows its history, then its reply as it streams, sending only what changed", async () => {
  const { api, spade, patches } = await phone((fake) => {
    fake.addAgent({ name: "Scout" });
  });
  const { agent, action } = opening(api, "Scout");
  api.store(agent.conversation, { type: "user_message", text: "Will it rain?" });
  api.reply(agent, "No rain today.");
  spade.handle(action);
  await until(() => bubbles(patches.flush()).length === 2);
  expect(conversation(patches.flush())).toMatchObject({ agentId: agent.id, loaded: true });
  const first = [...patches.flush().keys()].find((key) => key.startsWith("spade:bubble:")) ?? "";
  const firstPuts = patches.puts.get(first);

  api.store(agent.conversation, { type: "user_message", text: "And tomorrow?" });
  api.store(agent.conversation, { type: "reply_started", reply: "tomorrow" });
  api.status(agent, "working", "Checking the forecast");
  await until(() => conversation(patches.flush())?.status?.text === "Checking the forecast");
  expect(conversation(patches.flush())?.status?.moving).toBe(true);

  api.store(agent.conversation, {
    type: "reply_finished",
    reply: "tomorrow",
    text: "Tomorrow's wet.",
  });
  api.status(agent, "idle", null);
  await until(() => conversation(patches.flush())?.busy === false);
  expect(bubbles(patches.flush()).map((row) => [row?.kind, row?.text])).toEqual([
    ["person", "Will it rain?"],
    ["bot", "No rain today."],
    ["person", "And tomorrow?"],
    ["bot", "Tomorrow's wet."],
  ]);
  // The first message never changed, so it was never sent again.
  expect(patches.puts.get(first)).toBe(firstPuts);
});

test("a message sent from the phone shows at once and stays, once, after Spade stores it", async () => {
  const { daemon, api, spade, patches, ask } = await phone((fake) => {
    fake.addAgent({ name: "Scout" });
  });
  const { agent, action } = opening(api, "Scout");
  spade.handle(action);
  await until(() => conversation(patches.flush())?.loaded);
  daemon.spade.holding = true;
  const sent = ask({
    type: "spade.send",
    conversationId: agent.conversation,
    text: "Remember milk",
  });
  await until(() => daemon.spade.waiting === 1);
  // Before Spade has the message, it shows as sending.
  await until(() => bubbles(patches.flush())[0]?.sending === true);

  daemon.spade.letThrough();
  expect(await sent).toEqual({ ok: true });
  await until(() => bubbles(patches.flush())[0]?.sending === false);
  expect(texts(patches.flush())).toEqual(["Remember milk"]);
});

test("a message whose answer was lost with the connection counts as sent once Spade has it", async () => {
  const { daemon, api, spade, patches, ask } = await phone((fake) => {
    fake.addAgent({ name: "Scout" });
  });
  const { agent, action } = opening(api, "Scout");
  spade.handle(action);
  await until(() => conversation(patches.flush())?.loaded);
  daemon.spade.holding = true;
  const sent = ask({
    type: "spade.send",
    conversationId: agent.conversation,
    text: "Remember milk",
  });
  await until(() => daemon.spade.waiting === 1);
  // Spade stores it, then the socket drops before its answer reaches the phone.
  daemon.spade.letThrough(false);
  daemon.disconnectAll();
  // Not back in the composer, where sending it again would say it twice.
  expect(await sent).toEqual({ ok: true });
  await until(() => bubbles(patches.flush())[0]?.sending === false);
  expect(texts(patches.flush())).toEqual(["Remember milk"]);
});

test("a message Spade refused leaves the conversation and says why, for the composer to keep", async () => {
  const { api, daemon, spade, patches, ask } = await phone((fake) => {
    fake.addAgent({ name: "Scout" });
  });
  const { agent, action } = opening(api, "Scout");
  // Spade answers this bot's sends with its cap's refusal; everything else as before.
  daemon.spade.serve({
    answer: (request) =>
      request.path.endsWith("/messages")
        ? { status: 402, body: JSON.stringify({ error: "Scout is at its daily cap." }) }
        : api.answer(request),
    open: (path) => api.open(path),
  });
  spade.handle(action);
  await until(() => conversation(patches.flush())?.loaded);
  expect(
    await ask({ type: "spade.send", conversationId: agent.conversation, text: "Go on" }),
  ).toEqual({ ok: false, title: "Couldn't send it", message: "Scout is at its daily cap." });
  await until(() => bubbles(patches.flush()).length === 0);
});

test("an approval is the bot's bubble with its sentence and details, and goes once answered", async () => {
  const { api, spade, patches, ask } = await phone((fake) => {
    fake.addAgent({ name: "Mailer" });
  });
  const { agent, action } = opening(api, "Mailer");
  api.ask(agent, "k1", "send_email", { to: "sam@example.com" });
  spade.handle({ type: "spade.watch", on: true });
  await until(() => state(patches.flush())?.roster.rows?.length === 1);
  spade.handle(action);
  const asked = await until(() => bubbles(patches.flush()).find((row) => row?.kind === "ask"));
  expect(asked).toMatchObject({ callId: "k1", command: null });
  expect(String(asked.sentence)).toContain("Mailer");
  expect(asked.details).toContain("sam@example.com");
  expect(conversation(patches.flush())?.status).toEqual({ text: "Waiting for you", moving: false });

  expect(
    await ask({
      type: "spade.answer",
      conversationId: agent.conversation,
      callId: "k1",
      allowed: true,
      always: false,
    }),
  ).toEqual({ ok: true });
  await until(() => !bubbles(patches.flush()).some((row) => row?.kind === "ask"));
});

test("a conversation Spade no longer has says so instead of loading forever", async () => {
  const { spade, patches } = await phone();
  spade.handle({ type: "spade.open", bot: { agentId: "gone", conversationId: "c-gone" } });
  await until(() => conversation(patches.flush())?.problem ?? undefined);
  expect(conversation(patches.flush())?.problem).toBe("This conversation isn't in Spade any more.");
});

test("making a bot returns its conversation, and the roster lists it", async () => {
  const { api, spade, patches, ask } = await phone();
  spade.handle({ type: "spade.watch", on: true });
  const made = await ask({
    type: "spade.create",
    name: "Scout",
    task: "Find flats in Lisbon",
    model: "openrouter/saved/model",
    color: "teal",
  });
  const agent = api.agents.find((candidate) => candidate.name === "Scout");
  expect(made).toEqual({ ok: true, agentId: agent?.id, conversationId: agent?.conversation });
  expect(api.sent("POST", "/v1/agents")).toEqual([
    {
      name: "Scout",
      task: "Find flats in Lisbon",
      model: "openrouter/saved/model",
      avatar: { kind: "generated", color: "teal" },
    },
  ]);
  await until(() => state(patches.flush())?.roster.rows?.some((row) => row.name === "Scout"));
});

test("a bot whose making lost its answer keeps the form's words with the note, sent once", async () => {
  const { api, daemon, ask } = await phone();
  daemon.spade.holding = (request) => request.method === "POST";
  const made = ask({
    type: "spade.create",
    name: "Scout",
    task: "",
    model: "openrouter/saved/model",
    color: "slate",
  });
  await until(() => daemon.spade.waiting === 1);
  // Spade makes it, then the socket drops before its answer reaches the phone.
  daemon.spade.letThrough(false);
  daemon.disconnectAll();
  expect(await made).toEqual({ ok: false, unknown: true, note: spadeUnconfirmedBotNote });
  expect(api.agents.map((agent) => agent.name)).toEqual(["Scout"]);
});

test("a key goes to the machine's keychain through Spade, and the phone only learns it is set", async () => {
  const { api, ask } = await phone((fake) => {
    fake.endpoints.push({
      id: "openai",
      name: "OpenAI",
      format: "openai-chat",
      base_url: "https://api.openai.com/v1",
      needs_key: true,
      key_set: false,
      key_source: null,
      models: [{ id: "gpt", name: "GPT", context: 128_000 }],
    });
  });
  const before = await ask({ type: "spade.models" });
  expect(before).toMatchObject({
    ok: true,
    endpoints: [
      {
        key: { canSave: true, canRemove: false, placeholder: "Paste key" },
        models: [{ name: "GPT", facts: "128K context" }],
      },
    ],
    // Without a key no new bot can run on it.
    choices: [],
  });

  expect(await ask({ type: "spade.key", endpoint: "openai", key: "sk-test-123" })).toEqual({
    ok: true,
  });
  expect(api.sent("PUT", "/v1/keys/openai")).toEqual([{ key: "sk-test-123" }]);
  const after = await ask({ type: "spade.models" });
  expect(JSON.stringify(after)).not.toContain("sk-test-123");
  expect(after).toMatchObject({
    endpoints: [{ key: { description: "Set", canRemove: true } }],
    choices: [{ ref: "openai/gpt", label: "GPT · OpenAI" }],
  });

  expect(await ask({ type: "spade.key", endpoint: "openai", key: null })).toEqual({ ok: true });
});

test("while Spade is off a request says why instead of failing quietly", async () => {
  const { ask } = await phone((_api, fake) => {
    fake.spade.status = { state: "off" };
  });
  expect(await ask({ type: "spade.send", conversationId: "c-1", text: "Hi" })).toMatchObject({
    ok: false,
    title: "Couldn't send it",
    message: "Spade isn't running.",
  });
});
