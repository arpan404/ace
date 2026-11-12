import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { NativeSpade } from "./spade.ts";
import { answerSpade, type NativeSpadeRequest } from "./spade-requests.ts";

/*
 * Spade on the phone over the real SDK and the in-process fake daemon's Spade: what the Spade
 * place says, its list, one conversation streaming live, and the requests the phone makes.
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
    waiting,
  };
}

async function phone(setup: (daemon: FakeDaemon) => void = () => {}) {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: "studio", token: "ios-test-token" });
  daemon.spade.status = { state: "ready", version: "0.4.0" };
  setup(daemon);
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
  return { daemon, spade, patches, timers, ask };
}

type Held = Map<string, Record<string, unknown>>;
const state = (held: Held) =>
  held.get("spade:state") as {
    line: { sentence: string; ready: boolean; canTurnOn: boolean };
    enabled: boolean | null;
    list: { rows: { id: string; title: string; tone: string; label: string }[] | null };
  };
const conversation = (held: Held) =>
  held.get("spade:conversation") as {
    id: string;
    title: string;
    loaded: boolean;
    problem: string | null;
    answering: boolean;
    working: { label: string } | null;
    approval: { callId: string; sentence: string; more: number; details: string | null } | null;
  };
/** The open conversation's rows in order, as Swift lays them out. */
function rows(held: Held) {
  const order = (held.get("spade:order")?.order as string[] | undefined) ?? [];
  return order.map((key) => held.get(`spade:entry:${key}`)?.row as Record<string, unknown>);
}

test("with Spade off the place says so and offers Turn on, and Turn on saves the setting", async () => {
  const { daemon, spade, patches, ask } = await phone((fake) => {
    fake.spade.status = { state: "off" };
  });
  await ask({ type: "spade.enable", on: false });
  spade.handle({ type: "spade.watch", on: true });
  await until(() => state(patches.flush())?.enabled === false);
  expect(state(patches.flush()).line).toEqual({
    sentence: "Spade is off.",
    ready: false,
    canTurnOn: true,
  });

  expect(await ask({ type: "spade.enable", on: true })).toEqual({ ok: true });
  daemon.spade.setStatus({ state: "starting" });
  await until(() => state(patches.flush()).enabled === true);
  expect(state(patches.flush()).line.sentence).toBe("Spade is starting.");
});

test("the list says Approve before Working, else its age, and reads again on its own", async () => {
  const { daemon, spade, patches, timers } = await phone((fake) => {
    fake.spade.seed("quiet", "Trip plans", [{ type: "user_message", text: "Plan a trip" }]);
    fake.spade.seed("asks", "Email Sam", [
      { type: "reply_started", reply: "r1" },
      { type: "approval_requested", reply: "r1", call_id: "k1", name: "send_email" },
    ]);
  });
  spade.handle({ type: "spade.watch", on: true });
  const listed = await until(() => state(patches.flush())?.list.rows ?? undefined);
  expect(listed.map((row) => [row.title, row.tone, row.label === "Approve"])).toEqual([
    ["Email Sam", "needs-you", true],
    ["Trip plans", "idle", false],
  ]);

  // A row still open is read again soon; a new conversation shows on that read.
  daemon.spade.seed("new", "");
  timers.fire(2_000);
  await until(() => state(patches.flush()).list.rows?.length === 3);
  expect(state(patches.flush()).list.rows?.[0]).toMatchObject({
    id: "new",
    title: "New conversation",
  });
});

test("pull to refresh reads the list again at once", async () => {
  const { daemon, spade, patches } = await phone((fake) => {
    fake.spade.seed("one", "First");
  });
  spade.handle({ type: "spade.watch", on: true });
  await until(() => state(patches.flush())?.list.rows?.length === 1);
  daemon.spade.seed("two", "Second");
  spade.handle({ type: "spade.refresh" });
  await until(() => state(patches.flush()).list.rows?.length === 2);
});

test("a conversation shows its history, then Spade's reply as it streams, sending only what changed", async () => {
  const { daemon, spade, patches } = await phone((fake) => {
    fake.spade.seed("c1", "Weather", [
      { type: "user_message", text: "Will it rain?" },
      { type: "reply_started", reply: "r1" },
      { type: "reply_finished", reply: "r1", text: "No rain today." },
    ]);
  });
  spade.handle({ type: "spade.open", conversationId: "c1" });
  await until(() => daemon.spade.following("c1"));
  await until(() => rows(patches.flush()).length === 2);
  expect(conversation(patches.flush())).toMatchObject({ title: "Weather", loaded: true });
  const first = [...patches.flush().keys()].find((key) => key.startsWith("spade:entry:")) ?? "";
  const firstPuts = patches.puts.get(first);

  daemon.spade.store("c1", { type: "user_message", text: "And tomorrow?" });
  daemon.spade.store("c1", { type: "reply_started", reply: "r2" });
  daemon.spade.delta("c1", "r2", "Tomorrow looks ");
  await until(() => rows(patches.flush()).at(-1)?.live === "Tomorrow looks ");
  expect(conversation(patches.flush())).toMatchObject({
    answering: true,
    working: { label: "Working" },
  });

  daemon.spade.store("c1", { type: "reply_finished", reply: "r2", text: "Tomorrow looks wet." });
  await until(() => !conversation(patches.flush()).answering);
  expect(rows(patches.flush()).map((row) => row.kind)).toEqual(["user", "reply", "user", "reply"]);
  expect(rows(patches.flush()).at(-1)).toMatchObject({
    parts: [{ kind: "text", text: "Tomorrow looks wet." }],
    live: "",
    end: null,
  });
  // The first message never changed, so it was never sent again.
  expect(patches.puts.get(first)).toBe(firstPuts);
});

test("a message sent from the phone shows at once and stays, once, after Spade stores it", async () => {
  const { daemon, spade, patches, ask } = await phone((fake) => {
    fake.spade.seed("c1", "Notes", [{ type: "user_message", text: "Hello" }]);
  });
  spade.handle({ type: "spade.open", conversationId: "c1" });
  await until(() => daemon.spade.following("c1"));
  daemon.spade.holding = true;
  const sent = ask({ type: "spade.send", conversationId: "c1", text: "Remember milk" });
  await until(() => daemon.spade.waiting === 1);
  // Before Spade has the message, it shows as sending.
  await until(() => rows(patches.flush())[1]?.pending === true);
  expect(rows(patches.flush()).map((row) => row.text)).toEqual(["Hello", "Remember milk"]);

  daemon.spade.letThrough();
  expect(await sent).toEqual({ ok: true });
  await until(() => rows(patches.flush()).length === 2 && !rows(patches.flush())[1]?.pending);
  expect(rows(patches.flush()).map((row) => row.text)).toEqual(["Hello", "Remember milk"]);
});

test("a message whose answer was lost with the connection counts as sent once Spade has it", async () => {
  const { daemon, spade, patches, ask } = await phone((fake) => {
    fake.spade.seed("c1", "Notes", [{ type: "user_message", text: "Hello" }]);
  });
  spade.handle({ type: "spade.open", conversationId: "c1" });
  await until(() => daemon.spade.following("c1"));
  daemon.spade.holding = true;
  const sent = ask({ type: "spade.send", conversationId: "c1", text: "Remember milk" });
  await until(() => daemon.spade.waiting === 1);
  // Spade stores it, then the socket drops before its answer reaches the phone.
  daemon.spade.letThrough(false);
  daemon.disconnectAll();
  // Not back in the composer, where sending it again would say it twice.
  expect(await sent).toEqual({ ok: true });
  await until(() => rows(patches.flush()).length === 2 && !rows(patches.flush())[1]?.pending);
  expect(rows(patches.flush()).map((row) => row.text)).toEqual(["Hello", "Remember milk"]);
});

test("an approval shows its sentence and details, and moves on once answered", async () => {
  const { spade, patches, ask } = await phone((fake) => {
    fake.spade.seed("c1", "Email", [
      { type: "user_message", text: "Email Sam" },
      { type: "reply_started", reply: "r1" },
      {
        type: "approval_requested",
        reply: "r1",
        call_id: "k1",
        name: "send_email",
        arguments: { to: "sam@example.com" },
      },
    ]);
  });
  spade.handle({ type: "spade.open", conversationId: "c1" });
  const approval = await until(() => conversation(patches.flush())?.approval ?? undefined);
  expect(approval).toMatchObject({
    callId: "k1",
    sentence: "Spade wants to send an email.",
    more: 0,
  });
  expect(approval.details).toContain("sam@example.com");
  expect(conversation(patches.flush()).working?.label).toBe("Waiting for you");

  expect(
    await ask({
      type: "spade.answer",
      conversationId: "c1",
      callId: "k1",
      allowed: true,
      always: false,
    }),
  ).toEqual({ ok: true });
  await until(() => conversation(patches.flush()).approval === null);
});

test("after Spade restarts the conversation picks up where it left off, repeating nothing", async () => {
  const { daemon, spade, patches } = await phone((fake) => {
    fake.spade.seed("c1", "Plans", [{ type: "user_message", text: "One" }]);
  });
  spade.handle({ type: "spade.watch", on: true });
  spade.handle({ type: "spade.open", conversationId: "c1" });
  await until(() => daemon.spade.following("c1"));
  daemon.spade.setStatus({ state: "starting" });
  expect(daemon.spade.following("c1")).toBe(false);
  // Stored while the phone wasn't following: it arrives once the stream opens again.
  daemon.spade.store("c1", { type: "user_message", text: "Two" });
  daemon.spade.setStatus({ state: "ready" });
  await until(() => rows(patches.flush()).length === 2);
  await until(() => daemon.spade.following("c1"));
  expect(rows(patches.flush()).map((row) => row.text)).toEqual(["One", "Two"]);
});

test("a conversation Spade no longer has says so instead of loading forever", async () => {
  const { spade, patches } = await phone();
  spade.handle({ type: "spade.open", conversationId: "gone" });
  await until(() => conversation(patches.flush())?.problem ?? undefined);
  expect(conversation(patches.flush()).problem).toBe("This conversation isn't in Spade any more.");
});

test("starting a conversation returns where it is, and Stop with nothing answering is fine", async () => {
  const { daemon, spade, patches, ask } = await phone();
  const started = await ask({ type: "spade.start", text: "What's on today?" });
  expect(started).toMatchObject({ ok: true });
  const id = String("id" in started ? started.id : "");
  // The id is where Spade keeps it: its history holds the message that started it.
  spade.handle({ type: "spade.open", conversationId: id });
  await until(() => rows(patches.flush()).length === 1);
  expect(rows(patches.flush()).map((row) => row.text)).toEqual(["What's on today?"]);
  expect(await ask({ type: "spade.stop", conversationId: id })).toEqual({ ok: true });
  expect(daemon.spade.asked.map((call) => `${call.method} ${call.path}`)).toContain(
    `POST /v1/conversations/${id}/stop`,
  );
});

test("a start whose answer was lost opens the conversation Spade made, and makes no second one", async () => {
  const { daemon, spade, patches, ask } = await phone();
  daemon.spade.holding = (request) => request.method === "POST";
  const started = ask({ type: "spade.start", text: "What's on today?" });
  await until(() => daemon.spade.waiting === 1);
  // Spade makes the conversation, then the socket drops before its answer reaches the phone.
  daemon.spade.letThrough(false);
  daemon.disconnectAll();
  const outcome = await started;
  // Not back in the composer, where sending it again would start a second conversation.
  expect(outcome).toMatchObject({ ok: true });
  const id = "id" in outcome ? String(outcome.id) : "";

  spade.handle({ type: "spade.watch", on: true });
  await until(() => state(patches.flush())?.list.rows?.length);
  expect(state(patches.flush()).list.rows?.map((row) => row.id)).toEqual([id]);
  spade.handle({ type: "spade.open", conversationId: id });
  await until(() => rows(patches.flush()).length === 1);
  expect(rows(patches.flush()).map((row) => row.text)).toEqual(["What's on today?"]);
});

test("a key goes to the machine's keychain through Spade, and the phone only learns it is set", async () => {
  const { daemon, ask } = await phone((fake) => {
    fake.spade.models = {
      endpoints: [
        { id: "openai", name: "OpenAI", needs_key: true, models: [{ id: "gpt", name: "GPT" }] },
      ],
      roles: { main: "openai/gpt" },
      keychain: true,
    };
  });
  const before = await ask({ type: "spade.models" });
  expect(before).toMatchObject({
    ok: true,
    endpoints: [
      {
        key: { canSave: true, canRemove: false, placeholder: "Paste key" },
        models: [{ name: "GPT", roles: "Spade's Main model" }],
      },
    ],
  });

  expect(await ask({ type: "spade.key", endpoint: "openai", key: "sk-test-123" })).toEqual({
    ok: true,
  });
  expect(daemon.spade.keys.get("openai")).toBe("sk-test-123");
  const after = await ask({ type: "spade.models" });
  expect(JSON.stringify(after)).not.toContain("sk-test-123");
  expect(after).toMatchObject({ endpoints: [{ key: { description: "Set", canRemove: true } }] });

  expect(await ask({ type: "spade.key", endpoint: "openai", key: null })).toEqual({ ok: true });
  expect(daemon.spade.keys.has("openai")).toBe(false);
});

test("while Spade is off a request says why instead of failing quietly", async () => {
  const { ask } = await phone((fake) => {
    fake.spade.status = { state: "off" };
  });
  expect(await ask({ type: "spade.start", text: "Hi" })).toMatchObject({
    ok: false,
    title: "Couldn't start the conversation",
  });
});
