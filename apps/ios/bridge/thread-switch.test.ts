import { afterEach, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { ClientCore } from "@ace/client";
import type { ThreadSession } from "./thread-session.ts";
import { connect, fixture, latest, open, reset, sent, until } from "./thread-harness.ts";

/*
 * Moving an open thread to another model, account or provider from its model sheet, over the
 * real SDK and the fake daemon's accounts and catalog, by the web's switch rules.
 */

afterEach(reset);

type Tab = { id: string; provider: string | null; reason: string | null };
type Sheet = {
  state: string;
  tabs: Tab[];
  current: { provider: string; key: string; account: string } | null;
  currentLabel: string;
  rows: Record<string, { ask: number | null; note: string | null }>;
  asks: { title: string; message: string; action: string }[];
};
type Controls = { provider: string; model: string; note: string; switching: string };

const gpt = "codex\u0000gpt-6";
const opus = "claude\u0000claude-opus-5-5";
const row = (account: string, key: string) => `${account}\u0000${key}`;
const sheet = () => latest("thread.models") as Sheet | undefined;
const controls = () => (latest("thread.controls")?.row ?? undefined) as Controls | undefined;
const admission = (id: string) => latest("admission", id) as { ok: boolean; message: string };
const commands = (type: string) =>
  sent.flatMap((text) => {
    const message = JSON.parse(text) as { command?: { payload?: Record<string, unknown> } };
    const payload = message.command?.payload;
    return payload?.type === type ? [payload] : [];
  });

function codexThread(model = "gpt-6", running = false): FakeDaemon {
  const fake = fixture();
  fake.createThread({
    id: "sw",
    workspaceId: "ace",
    title: "Switch",
    provider: "codex",
    execution: { provider: "codex", model, instanceId: "codex-personal", options: {} },
  });
  fake.apply("sw", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Fix the build."),
    facts.message("root", "answer", "assistant", "Fixed."),
    ...(running ? [] : [facts.endTurn("root")]),
  ]);
  return fake;
}

async function openSheet(
  client: ClientCore,
  { fork = false } = {},
): Promise<{ thread: ThreadSession; ready: Sheet }> {
  const thread = open(client, "sw");
  await until(() => latest("thread.tune"), "the thread");
  if (fork) await forkOnSwitch(client);
  thread.handle({ type: "models" });
  const ready = await until(() => sheet()?.state === "ready" && sheet(), "the sheet");
  return { thread, ready };
}

async function forkOnSwitch(client: ClientCore): Promise<void> {
  await client.request({
    type: "settings.set",
    key: "threads.forkOnSwitch",
    value: true,
    layer: { kind: "global" },
  });
}

test("the sheet lists every set-up account, says which is at its limit, and checks the running model", async () => {
  const { ready } = await openSheet(connect(codexThread()));
  const ids = ready.tabs.map((tab) => tab.id);
  expect(ids[0]).toBe("favorites");
  expect(ids).toEqual(
    expect.arrayContaining(["codex:codex-personal", "codex:codex-team", "claude:claude-work"]),
  );
  expect(ready.tabs.find((tab) => tab.id === "codex:codex-team")?.reason).toMatch(/Limit reached/);
  expect(ready.current).toEqual({ provider: "codex", key: gpt, account: "codex-personal" });
});

test("a model the catalog doesn't list stays checked under its own name", async () => {
  const { ready } = await openSheet(connect(codexThread("gpt-retired-preview")));
  expect(ready.current).toMatchObject({ provider: "codex", account: "codex-personal" });
  expect(ready.currentLabel).not.toBe("");
});

test("another account of the same provider switches at once", async () => {
  const { thread, ready } = await openSheet(connect(codexThread()));
  expect(ready.rows[row("codex-team", gpt)]).toBeUndefined();
  thread.handle({
    type: "switchModel",
    key: gpt,
    account: "codex-team",
    confirmed: false,
    requestId: "team",
  });
  await until(() => latest("admission", "team"), "admission");
  expect(admission("team").ok).toBe(true);
  await until(() => commands("thread.switch").length === 1, "the switch on the wire");
  expect(commands("thread.switch")[0]?.selection).toMatchObject({
    provider: "codex",
    model: "gpt-6",
    instanceId: "codex-team",
  });
  await until(() => sheet()?.current?.account === "codex-team", "the new account checked");
});

test("a switch made while the agent works reads as pending until its next turn", async () => {
  const { thread } = await openSheet(connect(codexThread("gpt-6", true)));
  thread.handle({
    type: "switchModel",
    key: gpt,
    account: "codex-team",
    confirmed: false,
    requestId: "team",
  });
  await until(() => controls()?.note === "Applies at the agent's next turn", "the pending note");
  await until(() => controls()?.switching === "queued", "the daemon's queued switch");
  expect(controls()?.note).toBe("Applies at the agent's next turn");
});

test("another provider asks first, and nothing is sent until the person confirms", async () => {
  const { thread, ready } = await openSheet(connect(codexThread()));
  const asked = ready.rows[row("claude-personal", opus)];
  const ask = ready.asks[asked?.ask ?? -1];
  expect(ask?.title).toBe("Switch to Claude Code?");
  expect(ask?.message).toMatch(/stays behind/);
  const pick = (confirmed: boolean, requestId: string) =>
    thread.handle({
      type: "switchModel",
      key: opus,
      account: "claude-personal",
      confirmed,
      requestId,
    });
  pick(false, "unasked");
  await until(() => latest("admission", "unasked"), "refusal");
  expect(admission("unasked").ok).toBe(false);
  expect(commands("thread.switch")).toHaveLength(0);
  pick(true, "asked");
  await until(() => commands("thread.switch").length === 1, "the switch on the wire");
  expect(commands("thread.switch")[0]?.selection).toMatchObject({
    provider: "claude",
    instanceId: "claude-personal",
  });
  await until(() => controls()?.provider === "claude", "the composer on Claude");
});

test("with fork on switch, another provider continues in a new thread with the next message", async () => {
  const { thread, ready } = await openSheet(connect(codexThread()), { fork: true });
  const ask = ready.asks[ready.rows[row("claude-personal", opus)]?.ask ?? -1];
  expect(ask?.title).toBe("Continue in a new thread?");
  thread.handle({
    type: "switchModel",
    key: opus,
    account: "claude-personal",
    confirmed: true,
    requestId: "pick",
  });
  await until(() => controls()?.provider === "claude", "the composer naming Claude");
  expect(controls()?.note).toBe("Continues in a new thread with your next message");
  expect(commands("thread.switch")).toHaveLength(0);
  thread.handle({ type: "send", text: "Carry on there.", opposite: false, requestId: "go" });
  const continued = await until(() => latest("thread.continued"), "the new thread");
  const fork = commands("thread.fork")[0];
  expect(fork).toMatchObject({
    threadId: "sw",
    input: "Carry on there.",
    point: { type: "turn" },
    selection: { provider: "claude", instanceId: "claude-personal" },
  });
  expect(continued.opened).toMatch(/^sw-fork-/);
  expect(commands("thread.send")).toHaveLength(0);
  // This thread's composer is back on what it runs on.
  await until(() => controls()?.provider === "codex" && controls()?.note === "", "codex again");
});

test("picking the running model again drops a waiting continuation", async () => {
  const { thread } = await openSheet(connect(codexThread()), { fork: true });
  const pick = (key: string, account: string, requestId: string) =>
    thread.handle({ type: "switchModel", key, account, confirmed: true, requestId });
  pick(opus, "claude-personal", "away");
  await until(() => controls()?.provider === "claude", "the continuation");
  pick(gpt, "codex-personal", "back");
  await until(() => controls()?.provider === "codex" && controls()?.note === "", "back");
  thread.handle({ type: "send", text: "Stay here.", opposite: false, requestId: "here" });
  await until(() => commands("thread.send").length === 1, "a message to this thread");
  expect(commands("thread.fork")).toHaveLength(0);
});

test("a continuation waits while the agent's turn is still running", async () => {
  const { thread } = await openSheet(connect(codexThread("gpt-6", true)), { fork: true });
  thread.handle({
    type: "switchModel",
    key: opus,
    account: "claude-personal",
    confirmed: true,
    requestId: "pick",
  });
  await until(() => controls()?.provider === "claude", "the continuation");
  thread.handle({ type: "send", text: "Carry on.", opposite: false, requestId: "early" });
  await until(() => latest("admission", "early"), "refusal");
  expect(admission("early")).toMatchObject({
    ok: false,
    message: expect.stringMatching(/Stop it/),
  });
  expect(commands("thread.fork")).toHaveLength(0);
});
