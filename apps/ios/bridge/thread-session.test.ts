import { afterEach, expect, test, vi } from "vitest";

/*
 * The thread screen's bridge messages over the real SDK and an in-process fake daemon: the
 * production pump, item follower and thread session, with a test host standing in for Swift
 * (it decodes every frame and acknowledges it). No provider CLI runs.
 */

const native = vi.hoisted(() => {
  const state = { frames: [] as Record<string, unknown>[], ack: (_accepted: boolean) => {} };
  let next = 0;
  Object.assign(globalThis, {
    aceHost: {
      call: () => {},
      emit(frame: string) {
        state.frames.push(...(JSON.parse(frame) as Record<string, unknown>[]));
        setTimeout(() => state.ack(true), 0);
      },
      socket: () => {},
      timer: (_id: string, delay: number, callback: () => void) => setTimeout(callback, delay),
      cancelTimer: () => {},
      now: () => Date.now(),
      uuid: () => `id-${++next}`,
      random: () => 0.5,
      encode: (text: string) => [...new TextEncoder().encode(text)],
      utf8Base64: (text: string) => Buffer.from(text, "utf8").toString("base64"),
      previewHead: (text: string, limit: number) => text.slice(0, limit),
      previewTail: (text: string, limit: number) => text.slice(-limit),
      decode: (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes)),
      randomBytes: (count: number) => Array.from({ length: count }, () => 7),
      base64: (text: string, decode: boolean) =>
        decode
          ? Buffer.from(text, "base64").toString("binary")
          : Buffer.from(text, "binary").toString("base64"),
    },
  });
  return state;
});

import { ClientCore, type Lease, type ThreadSource } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { PatchPump, followThread } from "./patches.ts";
import { ThreadSession } from "./thread-session.ts";

const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
const sent: string[] = [];
let client: ClientCore | undefined;
let lease: Lease<ThreadSource> | undefined;
let stop: (() => void) | undefined;
let session: ThreadSession | undefined;

afterEach(async () => {
  session?.dispose();
  stop?.();
  lease?.release();
  await client?.close();
  native.frames.length = 0;
  sent.length = 0;
});

function connect(daemon: FakeDaemon): ClientCore {
  let saved: string | null = null;
  client = new ClientCore({
    deviceId: DeviceId.parse("ios-bridge-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => {
      const inner = fakeTransport(daemon);
      return {
        open: (events) => inner.open(events),
        send: (text) => {
          sent.push(text);
          inner.send(text);
        },
        close: () => inner.close(),
      };
    },
    credential: async () => ({ token: "ios-test-token" }),
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
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
  void client.start();
  return client;
}

function open(owner: ClientCore, threadId: string): ThreadSession {
  lease = owner.thread(threadId);
  stop = followThread(lease.store, threadId, 1, pump, 200);
  session = new ThreadSession(owner, lease.store, threadId, 1, pump);
  return session;
}

/** The latest delivered patch of a type for an id, as Swift would hold it. */
function latest(type: string, id?: string): Record<string, unknown> | undefined {
  for (let index = native.frames.length - 1; index >= 0; index--) {
    const frame = native.frames[index];
    if (frame?.type === type && (id === undefined || frame.id === id)) return frame;
  }
  return undefined;
}
const rows = (type: string) => {
  const byId = new Map<string, Record<string, unknown>>();
  for (const frame of native.frames)
    if (frame.type === type && typeof frame.id === "string") {
      if (frame.row) byId.set(frame.id, frame.row as Record<string, unknown>);
      else byId.delete(frame.id);
    }
  return [...byId.values()];
};
async function until<T>(read: () => T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const commands = (type: string) =>
  sent.flatMap((text) => {
    const message = JSON.parse(text) as {
      type?: string;
      command?: { payload?: { type?: string } };
    };
    return message.type === "command" && message.command?.payload?.type === type
      ? [message.command.payload as Record<string, unknown>]
      : [];
  });

function fixture(): FakeDaemon {
  return new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
  });
}

test("a finished turn folds its steps into one Worked for head with counts; its answer stays in view", async () => {
  const fake = fixture();
  fake.createThread({ id: "turn", workspaceId: "ace", title: "Turn", provider: "codex" });
  fake.apply("turn", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Fix the flaky test."),
    facts.tool("root", "read", {
      kind: "file.read",
      title: "Read queue.test.ts",
      detail: { kind: "file.read", path: "queue.test.ts" },
    }),
    facts.toolDone("root", "read"),
    facts.message("root", "answer", "assistant", "The test now pins the clock."),
    facts.endTurn("root"),
  ]);
  open(connect(fake), "turn");
  const work = await until(
    () => rows("thread.block").find((row) => row.kind === "work"),
    "a work block",
  );
  const items = rows("thread.item");
  const read = items.find((row) => row.type === "tool_call");
  const answer = items.find((row) => row.text === "The test now pins the clock.");
  expect(work.items).toEqual([read?.id]);
  expect(work.items).not.toContain(answer?.id);
  const summary = work.work as { label: string; counts: string; ongoing: boolean };
  expect(summary.label).toMatch(/^Worked for /);
  expect(summary.counts).toBe("Explored 1 file");
  expect(summary.ongoing).toBe(false);
  const kinds = rows("thread.block")
    .toSorted((a, b) => Number(a.index) - Number(b.index))
    .map((row) => row.kind);
  expect(kinds).toEqual(["user", "work", "message"]);
  expect(read?.step).toMatchObject({ verb: "Read" });
});

test("streaming text updates its item row alone and never re-sends blocks", async () => {
  const fake = fixture();
  fake.createThread({ id: "stream", workspaceId: "ace", title: "Stream", provider: "codex" });
  fake.apply("stream", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
    facts.message("root", "reply", "assistant", "Working", false),
  ]);
  open(connect(fake), "stream");
  await until(() => rows("thread.block").some((row) => row.kind === "message"), "the reply block");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = native.frames.filter((frame) => frame.type === "thread.block").length;
  fake.apply("stream", [facts.stream("root", "reply", " on it")]);
  await until(
    () => rows("thread.item").some((row) => row.text === "Working on it"),
    "the streamed text",
  );
  expect(native.frames.filter((frame) => frame.type === "thread.block").length).toBe(before);
});

test("a subagent group reads working while its child still runs after the parent's turn ends", async () => {
  const fake = fixture();
  fake.createThread({ id: "tree", workspaceId: "ace", title: "Tree", provider: "codex" });
  fake.apply("tree", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Review it."),
    facts.tool("root", "spawn", {
      kind: "agent.spawn",
      title: "Review PID reuse",
      detail: { kind: "agent.spawn", description: "Review PID reuse", childAgent: "reviewer" },
    }),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("root"),
  ]);
  open(connect(fake), "tree");
  const group = await until(
    () => rows("thread.block").find((row) => row.kind === "subagents"),
    "a subagent group",
  );
  const agents = group.agents as { entries: { state: string; agentId: string }[]; status: string };
  expect(agents.entries).toHaveLength(1);
  expect(agents.entries[0]?.state).toBe("working");
  expect(agents.entries[0]?.agentId).not.toBe("");
  expect(agents.status).toBe("1 working");
});

test("while the agent works a send queues by default and steers when the person asks", async () => {
  const fake = fixture();
  fake.createThread({ id: "busy", workspaceId: "ace", title: "Busy", provider: "codex" });
  fake.apply("busy", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  const thread = open(connect(fake), "busy");
  const controls = await until(
    () =>
      latest("thread.controls")?.row as
        | { busy: boolean; delivery: string; alternate: string }
        | undefined,
    "composer controls",
  );
  expect(controls).toMatchObject({ busy: true, delivery: "queue", alternate: "steer" });
  thread.handle({ type: "send", text: "Also run lint", opposite: false, requestId: "queue-1" });
  thread.handle({ type: "send", text: "Stop and explain", opposite: true, requestId: "steer-1" });
  await until(
    () => latest("admission", "steer-1")?.ok === true && latest("admission", "queue-1")?.ok,
    "admissions",
  );
  await until(() => commands("thread.send").length === 2, "both sends on the wire");
  expect(commands("thread.send").map((payload) => payload.delivery)).toEqual(["queue", "steer"]);
});

test("Stop interrupts the whole tree of the running turn", async () => {
  const fake = fixture();
  fake.createThread({ id: "stop", workspaceId: "ace", title: "Stop", provider: "codex" });
  fake.apply("stop", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  const thread = open(connect(fake), "stop");
  await until(
    () => (latest("thread.controls")?.row as { canStop?: boolean })?.canStop,
    "Stop offered",
  );
  thread.handle({ type: "stop", requestId: "stop-1" });
  await until(() => commands("thread.interrupt").length === 1, "the interrupt");
  expect(commands("thread.interrupt")[0]).toMatchObject({ threadId: "stop", cascade: true });
});

test("a question answer is admitted only when it fits what was asked, and closes the card", async () => {
  const fake = fixture();
  fake.createThread({ id: "ask", workspaceId: "ace", title: "Ask", provider: "claude" });
  fake.apply("ask", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "scope",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "archive",
            text: "Include the archived posts?",
            multiSelect: false,
            allowOther: true,
            options: [
              { id: "yes", label: "Include them (Recommended)" },
              { id: "no", label: "Skip the archive" },
            ],
          },
        ],
      },
    },
  ]);
  const thread = open(connect(fake), "ask");
  const card = await until(
    () =>
      rows("thread.interaction").find((row) => row.kind === "question" && row.state === "pending"),
    "the question card",
  );
  const question = (
    card.questions as {
      id: string;
      options: { id: string; label: string; recommended: boolean }[];
    }[]
  )[0];
  expect(question?.options[0]).toMatchObject({
    id: "yes",
    label: "Include them",
    recommended: true,
  });
  const interactionId = String(card.id);
  thread.handle({
    type: "answer",
    interactionId,
    answers: { archive: ["yes", "no"] },
    dismissed: false,
    requestId: "two",
  });
  thread.handle({
    type: "answer",
    interactionId,
    answers: {},
    dismissed: false,
    requestId: "none",
  });
  await until(() => latest("admission", "none"), "refusals");
  expect(latest("admission", "two")?.ok).toBe(false);
  expect(latest("admission", "none")?.ok).toBe(false);
  thread.handle({
    type: "answer",
    interactionId,
    answers: { archive: [" Only 2024 "] },
    dismissed: false,
    requestId: "own",
  });
  await until(() => latest("admission", "own")?.ok, "the free-text answer admitted");
  await until(
    () =>
      rows("thread.interaction").find(
        (row) => row.id === interactionId && row.state === "resolved",
      ),
    "the canonical resolution",
  );
  const resolve = commands("interaction.resolve");
  expect(resolve).toHaveLength(1);
  expect(resolve[0]?.resolution).toEqual({ kind: "question", answers: { archive: ["Only 2024"] } });
});

test("an approval names Allow once, Always allow and Deny by the request's exact options", async () => {
  const fake = fixture();
  fake.createThread({
    id: "grant",
    workspaceId: "ace",
    title: "Grant",
    provider: "codex",
    access: "ask",
  });
  fake.apply("grant", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.tool("root", "push", {
      kind: "shell",
      title: "Codex wants to run a command",
      status: "awaiting_approval",
      detail: { kind: "shell", command: "git push origin fix/queue" },
    }),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "push",
      item: "push",
      blocking: true,
      request: {
        kind: "approval",
        title: "Codex wants to run a command",
        options: [
          { id: "deny-it", label: "Deny", kind: "deny" },
          { id: "session-grant", label: "Always here", kind: "allow_session" },
          { id: "once", label: "Allow", kind: "allow_once" },
        ],
      },
    },
  ]);
  open(connect(fake), "grant");
  const card = await until(
    () => rows("thread.interaction").find((row) => row.kind === "approval"),
    "the approval card",
  );
  const options = card.options as { id: string }[];
  const decisions = (card.decisions as { verb: string; option: number; scope: string }[]).map(
    (decision) => [decision.verb, options[decision.option]?.id, decision.scope],
  );
  expect(decisions).toEqual([
    ["allow_once", "once", ""],
    ["always_allow", "session-grant", "Always here"],
    ["deny", "deny-it", ""],
  ]);
  expect(card.command).toBe("git push origin fix/queue");
});
