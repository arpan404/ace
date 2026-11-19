import "./test-host.ts";
import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, Notification, ThreadId } from "@ace/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationAction, NotificationBridge } from "./notifications.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const asking = ThreadId.parse("asking");
const finished = ThreadId.parse("finished");
function schedule(delay: number, run: () => void) {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
}

type Option = { id: string; label: string };
const question = (options: Option[], allowOther = false) => ({
  type: "interaction.opened" as const,
  agent: "root",
  interaction: "ask",
  blocking: true,
  request: {
    kind: "question" as const,
    questions: [
      {
        id: "scope",
        text: "Should the review include the archived posts?",
        multiSelect: false,
        allowOther,
        secret: false,
        options,
      },
    ],
  },
});

/** The real SDK against the fixture daemon; patches are what Swift would receive. */
async function phone(options: Option[], allowOther = false) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: asking,
    workspaceId: "ace",
    title: "Review the blog",
    provider: "claude",
  });
  daemon.apply(asking, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    question(options, allowOther),
  ]);
  daemon.createThread({
    id: finished,
    workspaceId: "ace",
    title: "Fix the flaky queue test",
    provider: "codex",
  });
  daemon.apply(finished, [facts.rootAgent("codex")]);
  const view = (id: ThreadId) => {
    const snapshot = daemon.snapshot({ kind: "thread", threadId: id });
    return snapshot?.kind === "thread" ? snapshot : undefined;
  };
  const interactionId = Object.values(view(asking)?.interactions ?? {})[0]?.id ?? "";
  let saved: string | null = null;
  let sequence = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    credential: async () => daemon.token,
    scheduler: { set: schedule },
    random: () => 0,
    id: () => `id-${++sequence}`,
  });
  const patches: Record<string, unknown>[] = [];
  const bridge = new NotificationBridge(
    client,
    (_key, read) => patches.push(read()),
    schedule,
    () => 12 * 60,
    200,
  );
  closers.push(async () => {
    bridge.close();
    await client.close();
  });
  await client.start();
  await vi.waitFor(() => expect(client.state).toBe("ready"));
  const act = (action: unknown) => bridge.handle(NotificationAction.parse(action));
  act({ type: "notifications.sync", enabled: true, appState: "background", cursor: 0 });
  const of = (type: string) => patches.filter((patch) => patch.type === type);
  const outcome = async (id: string) => {
    await vi.waitFor(() =>
      expect(
        of("notifications.action").some((patch) => patch.id === id && patch.outcome !== "saved"),
      ).toBe(true),
    );
    return of("notifications.action").findLast((patch) => patch.id === id)?.outcome;
  };
  const needsYou = () =>
    daemon.notify(
      Notification.parse({
        id: "n:ask",
        threadId: asking,
        title: "Review the blog",
        status: "needs_you",
        interactionId,
        backgroundCount: 0,
        actions: [],
      }),
    );
  return { daemon, act, of, outcome, view, interactionId, needsYou };
}

it("a short question's alert says who asks and offers its options as buttons", async () => {
  const { of, needsYou } = await phone([
    { id: "yes", label: "Include them" },
    { id: "no", label: "Skip the archive" },
  ]);
  needsYou();
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  expect(of("notifications.alert")[0]).toMatchObject({
    notification: {
      id: "n:ask",
      request: {
        kind: "question",
        sentence: expect.stringContaining("has a question"),
        detail: "Should the review include the archived posts?",
        questionId: "scope",
        choices: [
          { id: "yes", label: "Include them" },
          { id: "no", label: "Skip the archive" },
        ],
        reply: false,
      },
    },
  });
});

it("options too long or too many for buttons leave Reply, or opening ace, as the way to answer", async () => {
  const long = [
    { id: "a", label: "Rewrite every archived post in place" },
    { id: "b", label: "No" },
  ];
  const { of, needsYou } = await phone(long, true);
  needsYou();
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  expect(of("notifications.alert")[0]).toMatchObject({
    notification: { request: { choices: [], reply: true } },
  });
  const many = await phone(
    ["one", "two", "three", "four"].map((label) => ({ id: label, label })),
    true,
  );
  many.needsYou();
  await vi.waitFor(() => expect(many.of("notifications.alert")).toHaveLength(1));
  // Four options and Reply would be five buttons: the options don't fit.
  expect(many.of("notifications.alert")[0]).toMatchObject({
    notification: { request: { choices: [], reply: true } },
  });
});

it("an option tapped on the notification answers the pending question once", async () => {
  const { act, outcome, view, interactionId } = await phone([
    { id: "yes", label: "Include them" },
    { id: "no", label: "Skip the archive" },
  ]);
  const answer = (requestId: string, value: string, questionId = "scope") =>
    act({
      type: "notifications.answer",
      requestId,
      threadId: asking,
      interactionId,
      questionId,
      value,
    });
  // A button for an option the question doesn't offer answers nothing.
  answer("tap-0", "maybe");
  expect(await outcome("tap-0")).toBe("stale");
  answer("tap-1", "no");
  expect(await outcome("tap-1")).toBe("confirmed");
  expect(Object.values(view(asking)?.interactions ?? {})[0]).toMatchObject({
    state: "resolved",
    resolution: { kind: "question", answers: { scope: ["no"] } },
  });
  // The same button again finds nothing pending.
  answer("tap-2", "yes");
  expect(await outcome("tap-2")).toBe("stale");
});

it("Reply sends the words to the thread as its next message", async () => {
  const { act, outcome, view } = await phone([{ id: "yes", label: "Yes" }]);
  act({
    type: "notifications.reply",
    requestId: "reply-1",
    threadId: finished,
    text: "  Also run the linter  ",
  });
  expect(await outcome("reply-1")).toBe("confirmed");
  const messages = Object.values(view(finished)?.items ?? {}).filter(
    (item) => item.type === "message" && item.role === "user",
  );
  expect(messages).toMatchObject([{ parts: [{ type: "text", text: "Also run the linter" }] }]);
});

it("a question's own-words answer goes only where the question takes them", async () => {
  const closed = await phone([{ id: "yes", label: "Yes" }], false);
  const answer = (target: typeof closed, requestId: string) =>
    target.act({
      type: "notifications.answer",
      requestId,
      threadId: asking,
      interactionId: target.interactionId,
      questionId: "scope",
      value: "Only the 2024 posts",
    });
  answer(closed, "words-1");
  expect(await closed.outcome("words-1")).toBe("stale");
  const open = await phone([{ id: "yes", label: "Yes" }], true);
  answer(open, "words-2");
  expect(await open.outcome("words-2")).toBe("confirmed");
  expect(Object.values(open.view(asking)?.interactions ?? {})[0]).toMatchObject({
    resolution: { answers: { scope: ["Only the 2024 posts"] } },
  });
});
