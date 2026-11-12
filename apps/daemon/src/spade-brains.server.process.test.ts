import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  Command,
  DeviceId,
  ThreadId,
  type ServerMessage,
  type SpadeBrainFrame,
} from "@ace/protocol";
import type { Fact } from "@ace/core";
import { commandContext } from "./commands.ts";
import { fakeSpadeService } from "./__fixtures__/spade/fake-service.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { Client } from "./socket-test-support.ts";
import { connectSpadeMcp, spadeEnv, until } from "./spade-test-support.ts";

type Fixture = Awaited<ReturnType<typeof daemonFixture>>;
type Daemon = Fixture["daemon"];

const httpBase = (daemon: Daemon) => daemon.url.replace(/^ws:/, "http:");

/** Turns Spade on and returns the grant it was handed. */
async function startSpade(daemon: Daemon) {
  await daemon.settings.set("spade.enabled", true, { kind: "global" });
  await until(() => daemon.spade?.status().state === "ready", "Spade to be ready");
  return until(async () => (await spadeEnv(daemon)).grant, "Spade's grant");
}

/** A turn as Spade sends it; `frames` fills as JSON lines arrive, `done` when the answer ends. */
function sendTurn(daemon: Daemon, grant: string, body: Record<string, unknown>) {
  const frames: SpadeBrainFrame[] = [];
  const abort = new AbortController();
  const done = (async () => {
    const response = await fetch(`${httpBase(daemon)}/spade/brains/turn`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
      body: JSON.stringify({ bot: "b1", provider: "claude", model: "chosen-model", ...body }),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const read = await reader?.read();
      if (!read || read.done) break;
      buffered += decoder.decode(read.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        frames.push(JSON.parse(buffered.slice(0, newline)) as SpadeBrainFrame);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
  })();
  return { frames, done, abort };
}

/** The bot's hidden thread, once a turn named it. */
const sessionOf = (frames: SpadeBrainFrame[]) =>
  frames.find(
    (frame): frame is Extract<SpadeBrainFrame, { type: "session" }> => frame.type === "session",
  );

/** The provider answers in the bot's session, as the CLI would. */
function provide(f: Fixture, threadId: ThreadId, ...facts: Fact[]) {
  const ctx = f.h.contexts.get(threadId);
  if (!ctx) throw new Error("No session opened");
  ctx.onFrame(f.h.frames.frame(...facts));
}
const reply = (text: string, item = "answer"): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: { type: "message", role: "assistant", parts: [{ type: "text", text }], complete: true },
});
const ended = { type: "turn.ended", agent: "root", outcome: "completed" } satisfies Fact;

async function withSpade(run: (f: Fixture, grant: string) => Promise<void>) {
  let home = "";
  const service = fakeSpadeService(() => home);
  const f = await daemonFixture(undefined, {
    spade: { service: service.control, pollMs: { waiting: 50, ready: 200 } },
  });
  home = join(f.h.home, "daemon");
  try {
    await run(f, await startSpade(f.daemon));
  } finally {
    await f.daemon.close();
    await service.close();
  }
}

test("a bot on a subscription answers through its own hidden session, resumed every turn", async () => {
  await withSpade(async (f, grant) => {
    const { daemon } = f;
    const first = sendTurn(daemon, grant, {
      instructions: "You are Spade. Your task: keep notes.",
      message: "Hello",
    });
    const thread = ThreadId.parse(
      (await until(() => sessionOf(first.frames), "the bot's session")).thread,
    );
    expect(sessionOf(first.frames)?.fresh).toBe(true);
    await until(() => f.h.inputs.get(thread)?.length === 1, "the first message to arrive");
    provide(f, thread, reply("Hi, I'm here."), ended);
    await first.done;
    expect(
      first.frames.filter((frame) => frame.type === "text").map((frame) => frame.text),
    ).toEqual(["Hi, I'm here."]);
    expect(first.frames.at(-1)).toMatchObject({ type: "finished" });

    // The session is hidden: no list shows it, and no client may run a turn in it.
    expect(daemon.store.getThread(thread)).toMatchObject({ host: "spade-bot", hostKey: "b1" });
    expect(daemon.store.sidebarPage({ limit: 100 }).threads.map((t) => t.id)).not.toContain(thread);
    const refused = daemon.engine?.handler.handle(
      Command.parse({
        id: "person-send",
        deviceId: "desktop",
        payload: { type: "thread.send", threadId: thread, input: [{ type: "text", text: "hi" }] },
      }),
      commandContext(daemon.store),
    );
    expect(refused).toMatchObject({ ok: false, error: "host_thread" });

    // The next turn goes to the same session; instructions only when they changed.
    const second = sendTurn(daemon, grant, { instructions: "You are Spade.", message: "Again" });
    await until(() => sessionOf(second.frames), "the second turn's session");
    expect(sessionOf(second.frames)).toEqual({ type: "session", thread, fresh: false });
    await until(() => f.h.inputs.get(thread)?.length === 2, "the second message to arrive");
    provide(f, thread, reply("Still here.", "answer-2"), ended);
    await second.done;
    const sent = f.h.inputs.get(thread) ?? [];
    expect(sent[0]).toContain("Your task: keep notes.");
    expect(sent[0]).toContain("Hello");
    expect(sent[1]).toBe("Again");

    // After a daemon restart the bot's turn resumes the very same provider session.
    const restarted = await f.restart();
    await until(() => restarted.spade?.status().state === "ready", "Spade after the restart");
    const third = sendTurn(restarted, grant, {
      instructions: "You are Spade. Your task: keep tidy notes.",
      instructionsChanged: true,
      message: "After the restart",
    });
    expect((await until(() => sessionOf(third.frames), "the third turn")).thread).toBe(thread);
    await until(
      () => f.h.inputs.get(thread)?.some((text) => text.includes("After the restart")),
      "the third message to arrive",
    );
    // One provider session holds all three turns: the CLI kept its own context.
    const sessions = [...f.h.nativeHistories.values()].filter((history) =>
      history.some((text) => text.includes("After the restart")),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.some((text) => text.includes("Hello"))).toBe(true);
    expect(sessions[0]).toContain("Again");
    expect(f.h.inputs.get(thread)?.at(-1)).toContain("keep tidy notes");
    provide(f, thread, reply("Back.", "answer-3"), ended);
    await third.done;
    expect(third.frames.at(-1)).toMatchObject({ type: "finished" });
    await restarted.close();
  });
}, 60_000);

test("Stop cuts the CLI's turn: closing the request interrupts the bot's session", async () => {
  await withSpade(async (f, grant) => {
    const turn = sendTurn(f.daemon, grant, { instructions: "Rules", message: "Think long" });
    const thread = ThreadId.parse((await until(() => sessionOf(turn.frames), "session")).thread);
    await until(() => f.h.contexts.get(thread), "the CLI's session");
    turn.abort.abort();
    await turn.done.catch(() => {});
    await until(() => f.h.interrupts.includes(thread), "the CLI's turn to be interrupted");
  });
}, 30_000);

test("a signed-out CLI ends the turn with one line and is never sent the turn again", async () => {
  await withSpade(async (f, grant) => {
    const turn = sendTurn(f.daemon, grant, { instructions: "Rules", message: "Hello" });
    const thread = ThreadId.parse((await until(() => sessionOf(turn.frames), "session")).thread);
    await until(() => f.h.inputs.get(thread)?.length === 1, "the message to arrive");
    provide(f, thread, {
      type: "turn.ended",
      agent: "root",
      outcome: "failed",
      error: { kind: "auth", message: "Invalid API key · Please run /login" },
    });
    await turn.done;
    expect(turn.frames.at(-1)).toEqual({
      type: "failed",
      reason: "signed_out",
      message: "Claude Code is signed out. Sign in to it in ace, then send again.",
    });
    // Nothing retries it behind Spade's back.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.h.attempts.filter((attempt) => attempt.threadId === thread)).toHaveLength(1);
  });
}, 30_000);

test("subscriptions list the providers this daemon has installed and signed in, and a bot's own tools reach Spade only from its session", async () => {
  await withSpade(async (f, grant) => {
    const listed = await fetch(`${httpBase(f.daemon)}/spade/brains/subscriptions`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    const body = (await listed.json()) as {
      providers: { provider: string; models: { id: string }[] }[];
    };
    expect(body.providers.map((entry) => entry.provider).toSorted()).toEqual(["claude", "codex"]);
    expect(body.providers[0]?.models.map((model) => model.id)).toContain("chosen-model");
    // Without Spade's grant there is nothing to read.
    const refused = await fetch(`${httpBase(f.daemon)}/spade/brains/subscriptions`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(refused.status).toBe(401);

    const turn = sendTurn(f.daemon, grant, { instructions: "Rules", message: "Note this" });
    const thread = ThreadId.parse((await until(() => sessionOf(turn.frames), "session")).thread);
    const lease = (await until(() => f.h.contexts.get(thread), "the CLI's session")).aceMcp;
    if (!lease) throw new Error("The bot's session has no ace lease");
    const client = await connectSpadeMcp(lease.url, lease.bearer);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["spade_tools", "spade_call"]));
      expect(names).not.toContain("ask");
      const called = await client.callTool({
        name: "spade_call",
        arguments: { tool: "remember", arguments: { note: "milk" } },
      });
      expect(JSON.stringify(called.structuredContent)).toContain("b1 ran");
      expect(JSON.stringify(called.structuredContent)).toContain("milk");
      // Stamped with how many frames of the running turn came before it, so Spade applies
      // them (a web read) before admitting the call.
      expect(JSON.stringify(called.structuredContent)).toMatch(/dev\.acehq\.spade\/seq\\?":\d+/);
    } finally {
      await client.close();
    }
    // Spade's own host lease never sees them.
    const host = await connectSpadeMcp(`${httpBase(f.daemon)}/mcp`, grant);
    try {
      const names = (await host.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("spade_call");
    } finally {
      await host.close();
    }
    provide(f, thread, ended);
    await turn.done;
  });
}, 30_000);

/** A client's command over the socket, as the apps send it; its result or refusal. */
async function clientCommand(daemon: Daemon, payload: Record<string, unknown>) {
  const token = await readFile(daemon.tokenPath, "utf8");
  const socket = new Client(daemon.url);
  await once(socket.socket, "open");
  socket.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("desktop"), token });
  const command = Command.parse({ id: `client-${payload.type}`, deviceId: "desktop", payload });
  socket.send({ type: "command", command });
  try {
    for (;;) {
      const message: ServerMessage = await socket.next();
      if ("commandId" in message && message.commandId === command.id) return message;
    }
  } finally {
    await socket.close();
  }
}

test("a native permission prompt stops the bot's whole session and says it needs permission", async () => {
  await withSpade(async (f, grant) => {
    const turn = sendTurn(f.daemon, grant, { instructions: "Rules", message: "Tidy my notes" });
    const thread = ThreadId.parse((await until(() => sessionOf(turn.frames), "session")).thread);
    await until(() => f.h.inputs.get(thread)?.length === 1, "the message to arrive");
    provide(f, thread, {
      type: "interaction.opened",
      agent: "root",
      interaction: "edit-approval",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "go",
            text: "Edit notes.md?",
            options: [{ id: "yes", label: "Yes" }],
            multiSelect: false,
            allowOther: false,
            secret: false,
          },
        ],
      },
    });
    await turn.done;
    expect(turn.frames.at(-1)).toMatchObject({ type: "failed", reason: "needs_permission" });
    await until(() => f.h.interrupts.includes(thread), "the session to be interrupted");
  });
}, 30_000);

test("no client and no agent changes a bot's session: commands are refused and it stays read-only", async () => {
  await withSpade(async (f, grant) => {
    const turn = sendTurn(f.daemon, grant, { instructions: "Rules", message: "Hello" });
    const thread = ThreadId.parse((await until(() => sessionOf(turn.frames), "session")).thread);
    await until(() => f.h.inputs.get(thread)?.length === 1, "the message to arrive");
    provide(f, thread, reply("Hi."), ended);
    await turn.done;
    for (const payload of [
      { type: "thread.permission.set", threadId: thread, access: "full-access" },
      { type: "thread.rename", threadId: thread, title: "Mine now" },
      { type: "thread.interrupt", threadId: thread, cascade: true },
    ])
      expect(await clientCommand(f.daemon, payload)).toMatchObject({ code: "host_thread" });
    // Not through an agent's tools either, the session's own included.
    expect(
      f.controls.delegations.command("agent-widens", {
        type: "thread.permission.set",
        threadId: thread,
        access: "full-access",
      }),
    ).toMatchObject({ ok: false, error: "host_thread" });
    expect(f.daemon.store.getThread(thread)?.permission?.effective).toBe("read-only");
  });
}, 30_000);

test("a quota failure or a daemon restart holds nothing back: Spade's next turn goes straight to the CLI", async () => {
  await withSpade(async (f, grant) => {
    // The person lets ace resume limited threads at reset; a bot's session is not one of them.
    await f.daemon.settings.set("threads.limitPolicy", "resume_at_reset", { kind: "global" });
    const first = sendTurn(f.daemon, grant, { instructions: "Rules", message: "One" });
    const thread = ThreadId.parse((await until(() => sessionOf(first.frames), "session")).thread);
    await until(() => f.h.inputs.get(thread)?.length === 1, "the first message");
    const reset = f.h.clock.now() + 60_000;
    provide(
      f,
      thread,
      { type: "retry", agent: "root", on: "rate_limit", until: reset },
      {
        type: "turn.ended",
        agent: "root",
        outcome: "failed",
        error: { kind: "quota", message: "You've hit your usage limit" },
      },
    );
    await first.done;
    expect(first.frames.at(-1)).toMatchObject({ type: "failed", reason: "quota" });
    // The reset passes: nothing sends the cut turn again behind Spade's back.
    await new Promise((resolve) => setTimeout(resolve, 200));
    f.h.clock.advance(reset + 1_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(f.h.attempts.filter((a) => a.threadId === thread)).toHaveLength(1);
    // No limit hold: the next turn is sent at once.
    const second = sendTurn(f.daemon, grant, { instructions: "Rules", message: "Two" });
    await until(() => f.h.inputs.get(thread)?.includes("Two"), "the second message, unheld");

    // The daemon restarts mid-turn: nothing resumes or replays the cut turn by itself.
    const cut = second.done.catch(() => {});
    const restarted = await f.restart();
    await cut;
    try {
      await until(() => restarted.spade?.status().state === "ready", "Spade after the restart");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(f.h.attempts.filter((a) => a.threadId === thread).map((a) => a.text)).toEqual([
        expect.stringContaining("One"),
        "Two",
      ]);
      const third = sendTurn(restarted, grant, { instructions: "Rules", message: "Three" });
      await until(() => f.h.inputs.get(thread)?.includes("Three"), "the third message, unheld");
      provide(f, thread, reply("Done.", "answer-3"), ended);
      await third.done;
      expect(third.frames.at(-1)).toMatchObject({ type: "finished" });
    } finally {
      await restarted.close();
    }
  });
}, 60_000);
