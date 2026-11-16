import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeDigests,
  parseSpadeLiveFrame,
  spadeAskedAgain,
  spadeBubbles,
  spadeDigestMessage,
  spadeQuietLine,
  spadeRestLine,
  spadeView,
  withSpadeDigests,
  type SpadeConversationState,
  type SpadeRestNames,
} from "./index.ts";

/** A conversation fed the frames the live stream would send. */
function conversation() {
  const state: SpadeConversationState = emptySpadeConversation();
  let seq = 0;
  const frame = (event: string, data: unknown) => {
    const input = parseSpadeLiveFrame(event, JSON.stringify(data));
    if (input) foldSpade(state, input);
  };
  return {
    stored: (event: Record<string, unknown>, at = 1000 + seq) =>
      frame("stored", { seq: ++seq, at, event }),
    frame,
    view: () => spadeView(state),
  };
}

/** Each quiet line as it reads, and every other bubble by its kind. */
const lines = (c: ReturnType<typeof conversation>) =>
  spadeBubbles(c.view()).map((bubble) =>
    bubble.kind === "quiet"
      ? spadeQuietLine(bubble.quiet).label
      : bubble.kind === "bot"
        ? `bot: ${bubble.text}`
        : bubble.kind,
  );

const names: SpadeRestNames = {
  worker: (id) => ({ w1: "Linux repro" })[id],
  service: (id) => ({ s1: "dev server" })[id],
  bot: (id) => ({ b7: "Travel" })[id],
};
// 2026-11-15 12:00 UTC; the clock reads in UTC so the words are the same anywhere.
const now = Date.UTC(2026, 10, 15, 12, 0);
const clock = { now, locale: "en-US", timeZone: "UTC" };
const restOf = (c: ReturnType<typeof conversation>) => {
  const wake = c.view().resting;
  return wake && spadeRestLine(wake, names, clock);
};

const reply = (c: ReturnType<typeof conversation>, id: string, text: string) => {
  c.stored({ type: "reply_started", reply: id });
  c.stored({ type: "step_finished", reply: id, text });
  c.stored({ type: "reply_finished", reply: id, text });
};

describe("quiet lines", () => {
  test("a goal set and each check of done read as one line where they happened", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "get the relay PR green and merged" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "I'll start with the Linux failure." });
    c.stored({
      type: "goal_set",
      goal: "g1",
      title: "Get #2081 merged",
      text: "get the relay PR green",
      criteria: [],
      by: "bot",
    });
    c.stored({ type: "step_finished", reply: "r1", text: "Reading the log now." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Reading the log now." });
    c.stored({
      type: "task_verified",
      goal: "g1",
      claim: "c1",
      verdict: "not_yet",
      missing: ["Linux CI still fails", "no review"],
    });
    c.stored({ type: "task_verified", goal: "g1", claim: "c2", verdict: "unchecked" });
    c.stored({ type: "task_verified", goal: "g1", claim: "c3", verdict: "done" });
    expect(lines(c)).toEqual([
      "person",
      "bot: I'll start with the Linux failure.",
      "Goal set · Get #2081 merged",
      "bot: Reading the log now.",
      "Checked · not yet: Linux CI still fails, no review",
      "Says done, not checked",
      "Checked · done",
    ]);
  });

  test("a reply a quiet line split doesn't repeat its last words when it finishes", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "I'll start with Linux." });
    c.stored({
      type: "goal_set",
      goal: "g1",
      title: "Get #2081 merged",
      text: "",
      criteria: [],
      by: "bot",
    });
    c.stored({ type: "reply_finished", reply: "r1", text: "I'll start with Linux." });
    expect(lines(c)).toEqual(["bot: I'll start with Linux.", "Goal set · Get #2081 merged"]);
  });

  test("a worker made and its report read in the maker's chat, by name, with its face", () => {
    const c = conversation();
    c.stored({
      type: "worker_started",
      worker: "w1",
      kind: "bot",
      name: "Linux repro",
      call: "k1",
    });
    c.stored({
      type: "worker_started",
      worker: "t1",
      kind: "ace",
      name: "Fix the timer",
      call: "k2",
    });
    c.stored({ type: "worker_started", worker: "h1", kind: "helper", name: "helper", call: "k3" });
    c.stored({
      type: "worker_reported",
      worker: "t1",
      kind: "ace",
      name: "Fix the timer",
      state: "needs_you",
      epoch: "e",
      summary: "",
    });
    c.stored({
      type: "worker_reported",
      worker: "w1",
      kind: "bot",
      name: "Linux repro",
      state: "stopping",
      epoch: "e",
      summary: "",
    });
    c.stored({
      type: "worker_reported",
      worker: "w1",
      kind: "bot",
      name: "Linux repro",
      state: "done",
      epoch: "e2",
      summary: "",
    });
    expect(lines(c)).toEqual([
      "Made Linux repro",
      "Started Fix the timer",
      "Fix the timer needs you in Threads",
      "Linux repro is done",
    ]);
    const report = spadeBubbles(c.view()).at(-1);
    expect(report?.kind === "quiet" && spadeQuietLine(report.quiet).lead).toEqual({
      kind: "face",
      bot: "w1",
      pose: "done",
    });
  });
});

describe("asked again", () => {
  test("a step the review refused leaves nothing in the chat, only the bot's words", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [
        { id: "a", name: "shell", arguments: { command: "gh pr view 2076" } },
        { id: "b", name: "shell", arguments: { command: "gh pr comment 2076" } },
      ],
    });
    c.stored({ type: "tool_finished", reply: "r1", call_id: "a", name: "shell", content: "ok" });
    c.stored({
      type: "call_reviewed",
      reply: "r1",
      call_id: "b",
      name: "shell",
      verdict: "refuse",
      reason: "you asked about #2081, not #2076",
      model: "m",
    });
    // Its result is the refusal, which Spade returns as an ordinary result.
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "b",
      name: "shell",
      content: "Not run: …",
    });
    c.stored({ type: "step_finished", reply: "r1", text: "The review stopped me." });
    c.stored({ type: "reply_finished", reply: "r1", text: "The review stopped me." });
    expect(lines(c)).toEqual(["bot: The review stopped me."]);
  });

  test("a step the review allowed leaves nothing in the chat", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "", calls: [{ id: "a", name: "shell" }] });
    c.stored({
      type: "call_reviewed",
      reply: "r1",
      call_id: "a",
      name: "shell",
      verdict: "allow",
      reason: "",
      model: "m",
    });
    c.stored({ type: "tool_finished", reply: "r1", call_id: "a", name: "shell" });
    c.stored({ type: "reply_finished", reply: "r1", text: "Done." });
    expect(lines(c)).toEqual(["bot: Done."]);
  });

  test("the card asked again says so and leads with what was refused before", () => {
    expect(
      spadeAskedAgain(
        "Github watcher wants to run a command.",
        "Refused again: you asked about #2081, not #2076",
      ),
    ).toEqual({
      sentence: "Github watcher asks again to run a command.",
      before: "you asked about #2081, not #2076",
    });
    // A review that couldn't decide is a plain request.
    expect(spadeAskedAgain("Github watcher wants to run a script.", "The review timed out.")).toBe(
      undefined,
    );
  });
});

describe("the resting line", () => {
  test("a sleeping bot rests until its time, with why, and can be woken or its sleep cancelled", () => {
    const c = conversation();
    reply(c, "r1", "I'll look again once staging settles.");
    c.stored({
      type: "wake_set",
      wake: "k1",
      reply: "r1",
      purpose: { kind: "sleep" },
      due_ms: Date.UTC(2026, 10, 15, 14, 5),
      reason: "staging settles",
    });
    c.frame("status", { state: "sleeping", status: "Sleeping until 14:05: staging settles" });
    expect(c.view().busy).toBe(false);
    expect(restOf(c)).toEqual({
      wake: "k1",
      words: "Sleeping until 2:05 PM",
      why: "staging settles",
      actions: ["wake", "cancel"],
    });
    c.stored({ type: "wake_fired", wake: "k1", cause: "person" });
    expect(c.view().resting).toBe(undefined);
  });

  test("a wait names what it waits for and its timeout", () => {
    const c = conversation();
    c.stored({ type: "worker_started", worker: "w1", kind: "bot", name: "Linux repro", call: "k" });
    c.stored({
      type: "service_started",
      service: "s1",
      name: "dev server",
      command: "bun run dev",
    });
    const wait = (wake: string, condition: unknown, due?: number) =>
      c.stored({
        type: "wake_set",
        wake,
        purpose: { kind: "wait" },
        condition,
        ...(due === undefined ? {} : { due_ms: due }),
        reason: "",
      });
    wait("k1", { kind: "worker", worker: "w1" });
    expect(restOf(c)?.words).toBe("Waiting for Linux repro to report");
    c.stored({ type: "wake_cancelled", wake: "k1", by: "person" });
    wait(
      "k2",
      { kind: "service_line", service: "s1", pattern: "ready" },
      Date.UTC(2026, 10, 15, 14, 20),
    );
    expect(restOf(c)).toMatchObject({
      words: "Waiting for dev server to print “ready”",
      why: "until 2:20 PM at most",
    });
  });

  test("an open turn waiting out an outage rests with Try now and no Cancel", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "wake_set",
      wake: "k1",
      reply: "r1",
      purpose: { kind: "outage", attempt: 2, error: "503" },
      due_ms: Date.UTC(2026, 10, 16, 9, 0),
    });
    // The reply stays open, so Stop stays; it rests rather than works.
    expect(c.view().busy).toBe(true);
    expect(restOf(c)).toEqual({
      wake: "k1",
      words: "Waiting out an outage",
      why: "trying again at Mon 9:00 AM",
      actions: ["try"],
    });
  });

  test("a bot that works, or waits on the person, doesn't rest", () => {
    const c = conversation();
    c.stored({ type: "wake_set", wake: "k1", purpose: { kind: "sleep" }, due_ms: now + 60_000 });
    c.stored({ type: "reply_started", reply: "r1" });
    expect(c.view().resting).toBe(undefined);
    c.stored({ type: "approval_requested", reply: "r1", call_id: "a", name: "shell" });
    expect(c.view().resting).toBe(undefined);
  });
});

describe("digests", () => {
  const body = JSON.stringify({
    digests: [
      {
        id: "d2",
        agent: "github",
        made_ms: 5000,
        text: "Github watcher: 4 of 6 verified",
        digest: {
          agent: "github",
          name: "Github watcher",
          quiet: false,
          progress: {
            title: "Get #2081 merged",
            state: "not_yet",
            items_total: 6,
            items_verified: 4,
          },
          changed: [{ at_ms: 4000, text: "Closed: reproduce the Linux failure (verified)" }],
          decisions: [
            { at_ms: 4100, decision: "d1", choice: "Rebased on main", reason: "cleaner" },
          ],
          spend: { total_micros: 1_200_000, by_role: {} },
          next: ["Rerun Linux CI"],
          waiting: [{ level: "block", what: "a review of #2081", since_ms: 3000 }],
          workers: [
            {
              agent: "lark",
              name: "Linux repro",
              quiet: false,
              progress: { title: "Reproduce", state: "done", items_total: 3, items_verified: 3 },
              changed: [],
              workers: [],
            },
            { agent: "otter", name: "Changelog", quiet: true, changed: [], workers: [] },
          ],
          subtree_spend_micros: 3_960_000,
        },
      },
      { id: "d1", agent: "github", made_ms: 2000, text: "Quiet day.", digest: "unreadable" },
    ],
  });

  test("a maker's digest reads as a message with one line per worker; spend is plain", () => {
    const digests = parseSpadeDigests(body);
    const latest = digests?.at(-1);
    expect(latest && spadeDigestMessage(latest)).toEqual({
      heading: "Get #2081 merged · 4 of 6 verified",
      lines: [
        "Closed: reproduce the Linux failure (verified)",
        "Waits on you: a review of #2081",
        "Decided for you: Rebased on main",
      ],
      workers: [
        { agent: "lark", name: "Linux repro", line: " is done, 3 of 3 verified" },
        { agent: "otter", name: "Changelog", line: ": nothing new" },
      ],
      close: "Spent $3.96 across the team. Next: Rerun Linux CI.",
      plain: undefined,
    });
  });

  test("a digest whose parts can't be read shows Spade's text", () => {
    const first = parseSpadeDigests(body)?.[0];
    expect(first && spadeDigestMessage(first).plain).toBe("Quiet day.");
  });

  test("each digest sits in the chat where it was made, under a Digest time line", () => {
    const digests = parseSpadeDigests(body) ?? [];
    const items = [
      { kind: "bot", key: "a", at: 1000 },
      { kind: "bot", key: "b", at: 3000 },
      { kind: "bot", key: "c" },
    ];
    expect(withSpadeDigests(items, digests).map((item) => item.key)).toEqual([
      "a",
      "digest-time:d1",
      "digest:d1",
      "b",
      "c",
      "digest-time:d2",
      "digest:d2",
    ]);
  });
});
