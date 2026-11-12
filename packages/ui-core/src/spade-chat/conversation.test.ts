import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeView,
  type SpadeConversationState,
  type SpadeEntry,
} from "./index.ts";

/** A conversation fed the frames the live stream would send, by `event:` name and JSON body. */
function conversation() {
  const state: SpadeConversationState = emptySpadeConversation();
  let seq = 0;
  const frame = (event: string, data: unknown) => {
    const input = parseSpadeLiveFrame(event, JSON.stringify(data));
    if (input) foldSpade(state, input);
  };
  const stored = (event: Record<string, unknown>, at = 1000 + seq) =>
    frame("stored", { seq: ++seq, at, event });
  return {
    state,
    stored,
    frame,
    /** Send again a stored event already delivered, as a resubscribe's backlog may. */
    replay: (at: number, event: Record<string, unknown>) =>
      frame("stored", { seq: at, at: 0, event }),
    view: () => spadeView(state),
  };
}

const said = (entries: readonly SpadeEntry[]) =>
  entries.map((entry) =>
    entry.kind === "user"
      ? `person: ${entry.text}${entry.pending ? " (sending)" : ""}`
      : entry.kind === "reply"
        ? `spade: ${[
            ...entry.parts.map((part) =>
              part.kind === "call"
                ? `[${part.name} ${part.state}]`
                : part.kind === "remembered"
                  ? `[remembered ${part.note.text}]`
                  : part.kind === "files"
                    ? `[files ${part.paths.join(", ")}]`
                    : part.text,
            ),
            ...(entry.live ? [`${entry.live}…`] : []),
          ].join(" | ")}${entry.end ? ` (${entry.end.kind})` : ""}`
        : entry.kind,
  );

describe("a reply", () => {
  test("streams live pieces, then reads as finished once without repeating its words", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Hi" });
    c.stored({ type: "reply_started", reply: "r1", model: "m" });
    c.frame("delta", { reply: "r1", text: "Hel" });
    c.frame("delta", { reply: "r1", text: "lo" });
    expect(said(c.view().entries)).toEqual(["person: Hi", "spade: Hello…"]);
    expect(c.view().answering).toBe(true);
    c.stored({ type: "step_finished", reply: "r1", text: "Hello" });
    c.stored({ type: "reply_finished", reply: "r1", text: "Hello", cost_micros: 1 });
    expect(said(c.view().entries)).toEqual(["person: Hi", "spade: Hello (finished)"]);
    expect(c.view()).toMatchObject({ answering: false, busy: false, working: undefined });
  });

  test("a checkpoint behind the live pieces doesn't cut the words short", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.frame("delta", { reply: "r1", text: "Hello there" });
    c.stored({ type: "reply_progress", reply: "r1", text: "Hello" });
    expect(said(c.view().entries)).toEqual(["spade: Hello there…"]);
  });

  test("a snapshot after a reconnect replaces what arrived before it", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.frame("delta", { reply: "r1", text: "Hel" });
    // The stream dropped; on resubscribe Spade sends everything the open step has.
    c.frame("snapshot", { reply: "r1", text: "Hello wor" });
    c.frame("delta", { reply: "r1", text: "ld" });
    expect(said(c.view().entries)).toEqual(["spade: Hello world…"]);
  });

  test("stopped keeps the words that arrived and is no longer answering", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.frame("delta", { reply: "r1", text: "Half a" });
    c.stored({ type: "reply_stopped", reply: "r1", text: "Half a" });
    expect(said(c.view().entries)).toEqual(["spade: Half a (stopped)"]);
    expect(c.view().answering).toBe(false);
  });

  test("a failure says why", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "reply_failed", reply: "r1", text: "", error: "the model is overloaded" });
    const reply = c.view().entries[0];
    expect(reply?.kind === "reply" && reply.end).toEqual({
      kind: "failed",
      error: "the model is overloaded",
    });
  });

  test("words before and after a tool read as separate steps", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Let me look.",
      calls: [{ id: "c1", name: "web_search", arguments: {} }],
    });
    c.stored({ type: "tool_started", reply: "r1", call_id: "c1", name: "web_search" });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "c1",
      name: "web_search",
      content: "…",
    });
    c.stored({ type: "step_finished", reply: "r1", text: "Found it." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Found it." });
    expect(said(c.view().entries)).toEqual([
      "spade: Let me look. | [web_search done] | Found it. (finished)",
    ]);
  });
});

describe("what stays open", () => {
  test("a running tool shows on the Working line in words", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" }, 5000);
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "c1", name: "web_search", arguments: {} }],
    });
    c.stored({ type: "tool_started", reply: "r1", call_id: "c1", name: "web_search" });
    expect(c.view().working).toEqual({ label: "Searching the web", since: 5000, moving: true });
  });

  test("an approval waits in its sentence and keeps the conversation busy until answered", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "c1", name: "send_email", arguments: { to: "a@b.c" } }],
    });
    c.stored({
      type: "approval_requested",
      reply: "r1",
      call_id: "c1",
      name: "send_email",
      arguments: { to: "a@b.c" },
    });
    expect(c.view().approvals).toEqual([
      expect.objectContaining({ callId: "c1", sentence: "Spade wants to send an email." }),
    ]);
    expect(c.view().working).toMatchObject({ label: "Waiting for you", moving: false });
    expect(c.view().busy).toBe(true);
    c.stored({ type: "approval_answered", reply: "r1", call_id: "c1", allowed: false });
    expect(c.view().approvals).toEqual([]);
    expect(said(c.view().entries)).toEqual(["spade: [send_email declined]"]);
  });

  test("a background job keeps the conversation working after its reply finished", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "job_started", reply: "r1", job: "j1", name: "research" });
    c.stored({ type: "step_finished", reply: "r1", text: "Started it." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Started it." });
    expect(c.view()).toMatchObject({
      answering: false,
      busy: true,
      working: { label: "Researching in the background", since: undefined },
    });
    c.stored({ type: "job_finished", job: "j1", name: "research", content: "done" });
    expect(c.view()).toMatchObject({ busy: false, working: undefined });
    expect(c.view().entries.at(-1)).toMatchObject({ kind: "job", name: "research" });
  });

  test("a restart mid-reply closes it as interrupted, with nothing left running", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "c1", name: "web_fetch", arguments: {} }],
    });
    c.stored({ type: "tool_started", reply: "r1", call_id: "c1", name: "web_fetch" });
    c.stored({ type: "reply_interrupted", reply: "r1", text: "" });
    expect(c.view()).toMatchObject({ busy: false, working: undefined, approvals: [] });
    expect(said(c.view().entries)).toEqual(["spade: [web_fetch skipped] (interrupted)"]);
  });
});

describe("restarts and resubscribes", () => {
  test("events delivered again after a resubscribe are dropped", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Hi" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.replay(1, { type: "user_message", text: "Hi" });
    c.replay(2, { type: "reply_started", reply: "r1" });
    expect(said(c.view().entries)).toEqual(["person: Hi", "spade: "]);
    expect(c.state.lastSeq).toBe(2);
  });

  test("an event type this client doesn't know is kept count of and changes nothing shown", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Hi" });
    c.stored({ type: "memory_saved", fact: "likes tea" });
    c.frame("presence", { who: "x" });
    expect(said(c.view().entries)).toEqual(["person: Hi"]);
    expect(c.state.unknown).toBe(1);
    expect(c.state.lastSeq).toBe(2);
  });

  test("a frame that isn't JSON is skipped", () => {
    const c = conversation();
    expect(parseSpadeLiveFrame("stored", "{not json")).toBeUndefined();
    expect(c.view().loaded).toBe(false);
  });
});

test("each view is a snapshot: a later event never changes a view already taken", () => {
  const c = conversation();
  c.stored({ type: "user_message", text: "Hi" });
  const before = c.view();
  c.stored({ type: "reply_started", reply: "r1" });
  expect(said(before.entries)).toEqual(["person: Hi"]);
  expect(said(c.view().entries)).toEqual(["person: Hi", "spade: "]);
});

describe("sending", () => {
  test("a sent message shows at once and is replaced by Spade's stored copy", () => {
    const c = conversation();
    foldSpade(c.state, { kind: "sent", key: "local-1", text: "Hi" });
    expect(said(c.view().entries)).toEqual(["person: Hi (sending)"]);
    c.stored({ type: "user_message", text: "Hi" });
    expect(said(c.view().entries)).toEqual(["person: Hi"]);
  });

  test("a refused message leaves the conversation", () => {
    const c = conversation();
    foldSpade(c.state, { kind: "sent", key: "local-1", text: "Hi" });
    foldSpade(c.state, { kind: "refused", key: "local-1" });
    expect(c.view().entries).toEqual([]);
  });

  test("a message sent while answering steers the open reply, which stays open", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Plan a trip" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "user_message", text: "Make it cheap" });
    c.frame("delta", { reply: "r1", text: "Cheap options" });
    expect(c.view().answering).toBe(true);
    expect(said(c.view().entries)).toEqual([
      "person: Plan a trip",
      "person: Make it cheap",
      "spade: Cheap options…",
    ]);
  });

  test("a steer after a step leaves that step above the message and the rest below", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Plan a trip" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Looking.",
      calls: [{ id: "c1", name: "web_search", arguments: {} }],
    });
    c.stored({ type: "user_message", text: "Make it cheap" });
    c.stored({ type: "tool_started", reply: "r1", call_id: "c1", name: "web_search" });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "c1",
      name: "web_search",
      content: "",
    });
    c.stored({ type: "step_finished", reply: "r1", text: "Cheap options." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Cheap options." });
    expect(said(c.view().entries)).toEqual([
      "person: Plan a trip",
      "spade: Looking. | [web_search done]",
      "person: Make it cheap",
      "spade: Cheap options. (finished)",
    ]);
    expect(c.view().busy).toBe(false);
  });
});

test("compaction leaves a quiet marker and a rename sets the title", () => {
  const c = conversation();
  c.stored({ type: "user_message", text: "Hi" });
  c.stored({ type: "context_compacted", summary: "…", keep_from: 1, tokens_before: 9000 });
  c.stored({ type: "renamed", title: "Greetings" });
  expect(said(c.view().entries)).toEqual(["person: Hi", "compacted"]);
  expect(c.view().title).toBe("Greetings");
});

const hash = (digit: string) => digit.repeat(64);

describe("the Spade API's later details", () => {
  test("caught_up marks an empty conversation loaded and caught up", () => {
    const c = conversation();
    expect(c.view()).toMatchObject({ loaded: false, caughtUp: false });
    c.frame("caught_up", { seq: 0 });
    expect(c.view()).toMatchObject({ loaded: true, caughtUp: true, entries: [] });
  });

  test("a message's images show with it, and a sent one is replaced by its stored copy", () => {
    const c = conversation();
    const image = { sha256: hash("a"), mediaType: "image/png", bytes: 120 };
    foldSpade(c.state, { kind: "sent", key: "local-1", text: "", images: [image] });
    expect(c.view().entries).toEqual([
      { kind: "user", key: "local-1", text: "", images: [image], pending: true },
    ]);
    c.stored({
      type: "user_message",
      text: "",
      images: [{ sha256: hash("a"), media_type: "image/png", bytes: 120 }, { sha256: "bad" }],
    });
    expect(c.view().entries).toEqual([{ kind: "user", key: "s1", text: "", images: [image] }]);
  });

  test("a sent message isn't taken for a stored one with other images", () => {
    const c = conversation();
    foldSpade(c.state, { kind: "sent", key: "local-1", text: "Look" });
    c.stored({
      type: "user_message",
      text: "Look",
      images: [{ sha256: hash("b"), media_type: "image/jpeg", bytes: 9 }],
    });
    expect(c.view().entries.map((entry) => entry.key)).toEqual(["s1", "local-1"]);
  });

  test("stop_requested shows nothing; the ends that follow it do", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "stop_requested", reply: "r1", jobs: [] });
    expect(c.view().answering).toBe(true);
    expect(c.state.unknown).toBe(0);
    c.stored({ type: "reply_stopped", reply: "r1", text: "" });
    expect(c.view().answering).toBe(false);
  });

  test("a background job running beside an open reply is named on the Working line", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" }, 7000);
    c.stored({ type: "job_started", reply: "r1", job: "j1", name: "research" });
    expect(c.view().working).toEqual({
      label: "Researching in the background",
      since: 7000,
      moving: true,
    });
  });
});

test("a call made through call_tool reads as the tool it reached", () => {
  const c = conversation();
  c.stored({ type: "reply_started", reply: "r1" });
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: [{ id: "c1", name: "call_tool", arguments: { name: "ace_thread_send" } }],
  });
  c.stored({
    type: "approval_requested",
    reply: "r1",
    call_id: "c1",
    name: "ace_thread_send",
    arguments: {},
  });
  c.stored({ type: "approval_answered", reply: "r1", call_id: "c1", allowed: false });
  // Spade then answers the call for the model; the person still declined it.
  c.stored({
    type: "tool_finished",
    reply: "r1",
    call_id: "c1",
    name: "ace_thread_send",
    content: "The person declined this action.",
    is_error: true,
  });
  expect(said(c.view().entries)).toEqual(["spade: [ace_thread_send declined]"]);
});

const delegated = (c: ReturnType<typeof conversation>, calls: { id: string; args: unknown }[]) => {
  c.stored({ type: "reply_started", reply: "r1" }, 9000);
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: calls.map((call) => ({ id: call.id, name: "call_tool", arguments: call.args })),
  });
  for (const call of calls)
    c.stored({ type: "job_started", reply: "r1", job: call.id, name: "delegate" });
};

describe("delegation", () => {
  test("a delegation keeps the conversation working, counting its agents, until they settle", () => {
    const c = conversation();
    delegated(c, [
      {
        id: "c1",
        args: { name: "delegate", arguments: { tasks: [{ task: "a" }, { task: "b" }] } },
      },
    ]);
    c.stored({ type: "step_finished", reply: "r1", text: "Two agents are on it." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Two agents are on it." });
    expect(c.view()).toMatchObject({
      answering: false,
      busy: true,
      working: { label: "Waiting for 2 agents", since: undefined },
    });
    c.stored({ type: "job_finished", job: "c1", name: "delegate", content: "done" });
    expect(c.view()).toMatchObject({ busy: false, working: undefined });
  });

  test("delegations add up; one that doesn't say how many reads as agents", () => {
    const counted = conversation();
    delegated(counted, [
      { id: "c1", args: { tasks: [{}] } },
      { id: "c2", args: { tasks: [{}, {}] } },
    ]);
    expect(counted.view().working?.label).toBe("Waiting for 3 agents");

    const uncounted = conversation();
    delegated(uncounted, [
      { id: "c1", args: { tasks: [{}] } },
      { id: "c2", args: {} },
    ]);
    expect(uncounted.view().working?.label).toBe("Waiting for agents");
  });
});

describe("stopping", () => {
  test("a job Stop ended reads as stopped, not failed; one that failed on its own as failed", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "job_started", reply: "r1", job: "j1", name: "delegate" });
    c.stored({ type: "job_started", reply: "r1", job: "j2", name: "research" });
    c.stored({ type: "step_finished", reply: "r1", text: "On it." });
    c.stored({ type: "reply_finished", reply: "r1", text: "On it." });
    c.stored({ type: "job_finished", job: "j2", name: "research", content: "", is_error: true });
    c.stored({ type: "stop_requested", jobs: ["j1"] });
    c.stored({ type: "job_finished", job: "j1", name: "delegate", content: "", is_error: true });
    expect(c.view().entries.slice(-2)).toMatchObject([
      { kind: "job", name: "research", outcome: "failed" },
      { kind: "job", name: "delegate", outcome: "stopped" },
    ]);
    expect(c.view().busy).toBe(false);
  });

  test("stopping a reply stops the jobs it started and hides its approval", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "job_started", reply: "r1", job: "j1", name: "research" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "c1", name: "send_email", arguments: {} }],
    });
    c.stored({
      type: "approval_requested",
      reply: "r1",
      call_id: "c1",
      name: "send_email",
      arguments: {},
    });
    c.stored({ type: "stop_requested", reply: "r1", jobs: [] });
    expect(c.view().approvals).toEqual([]);
    c.stored({ type: "reply_stopped", reply: "r1", text: "" });
    c.stored({ type: "job_finished", job: "j1", name: "research", content: "", is_error: true });
    expect(c.view().entries.at(-1)).toMatchObject({ kind: "job", outcome: "stopped" });
  });
});

test("a job's end reads above the words that answer it", () => {
  const c = conversation();
  c.stored({ type: "reply_started", reply: "r1" });
  c.stored({ type: "job_started", reply: "r1", job: "j1", name: "research" });
  c.stored({ type: "step_finished", reply: "r1", text: "Started it." });
  c.stored({ type: "reply_finished", reply: "r1", text: "Started it." });
  // The result reopens a turn, which answers it.
  c.stored({ type: "reply_started", reply: "r2" });
  c.frame("delta", { reply: "r2", text: "Here is what" });
  c.stored({ type: "job_finished", job: "j1", name: "research", content: "found" });
  c.frame("delta", { reply: "r2", text: " I found." });
  expect(said(c.view().entries)).toEqual([
    "spade: Started it. (finished)",
    "job",
    "spade: Here is what I found.…",
  ]);
});

describe("the conversation as a chat", () => {
  test("bubbles show both sides' words and nothing of the tools, jobs or compaction", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Find me a flight" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Looking.",
      calls: [{ id: "k1", name: "web_search" }],
    });
    c.stored({ type: "tool_started", reply: "r1", call_id: "k1", name: "web_search" });
    c.stored({ type: "tool_finished", reply: "r1", call_id: "k1", name: "web_search" });
    c.stored({ type: "job_started", reply: "r1", job: "k1", name: "research" });
    c.stored({ type: "job_finished", job: "k1", name: "research" });
    c.stored({ type: "context_compacted" });
    c.stored({ type: "step_finished", reply: "r1", text: "The 9:40 is cheapest." });
    c.stored({ type: "reply_finished", reply: "r1", text: "The 9:40 is cheapest." });
    c.stored({
      type: "user_message",
      text: "Booked it for you.",
      from_agent: { id: "a7", name: "Travel", depth: 1 },
    });
    expect(
      spadeBubbles(c.view()).map((bubble) =>
        bubble.kind === "ask"
          ? `ask: ${bubble.sentence}`
          : bubble.kind === "other"
            ? `${bubble.agent.name}: ${bubble.text}`
            : bubble.kind === "routine"
              ? `routine: ${bubble.name}`
              : bubble.kind === "remembered"
                ? `remembered: ${bubble.note.text}`
                : bubble.kind === "files"
                  ? `files: ${bubble.paths.join(", ")}`
                  : `${bubble.kind}: ${bubble.text}`,
      ),
    ).toEqual([
      "person: Find me a flight",
      "bot: Looking.",
      "bot: The 9:40 is cheapest.",
      "Travel: Booked it for you.",
    ]);
  });

  test("an approval arrives as the bot's bubble and leaves once answered", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "approval_requested", reply: "r1", call_id: "k9", name: "send_email" });
    expect(spadeBubbles(c.view()).at(-1)).toMatchObject({ kind: "ask", callId: "k9" });
    c.stored({ type: "approval_answered", reply: "r1", call_id: "k9", allowed: true });
    expect(spadeBubbles(c.view()).some((bubble) => bubble.kind === "ask")).toBe(false);
  });

  test("the bot's own words on what it does show while it works and go when the reply ends", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.frame("status", { state: "working", status: "Reading a page", extra: 1 });
    c.frame("status", { state: "dreaming" });
    expect(c.view().status).toBe("Reading a page");
    c.stored({ type: "reply_finished", reply: "r1", text: "Done." });
    expect(c.view().status).toBeUndefined();
  });
});
