import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeActivity,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeStepsQuery,
  spadeStepsWithActivity,
  spadeView,
  type SpadeBubble,
} from "./index.ts";

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: 1000, event }));
    if (input) foldSpade(state, input);
  };
  /** One model step: its words and the calls it made, each then finished. */
  const step = (reply: string, text: string, calls: [string, string, boolean?][]) => {
    stored({
      type: "step_finished",
      reply,
      text,
      calls: calls.map(([id, name]) => ({ id, name, arguments: {} })),
    });
    for (const [id, name, failed] of calls)
      stored({ type: "tool_finished", reply, call_id: id, name, content: "", is_error: !!failed });
  };
  return { stored, step, bubbles: () => spadeBubbles(spadeView(state)) };
}

/** The bubbles as short lines: words, "steps: <summary>", "ask <state>". */
const read = (bubbles: SpadeBubble[]) =>
  bubbles.map((bubble) =>
    bubble.kind === "bot"
      ? bubble.text
      : bubble.kind === "steps"
        ? `steps: ${bubble.summary}`
        : bubble.kind === "ask"
          ? `ask ${bubble.state}`
          : bubble.kind,
  );

describe("a reply's steps", () => {
  test("fold into one line under its last words, like steps counted together", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.step("r1", "On it.", [
      ["a", "shell"],
      ["b", "shell"],
      ["c", "workspace_write"],
    ]);
    c.step("r1", "", [["d", "shell"]]);
    c.stored({ type: "reply_finished", reply: "r1", text: "Done: the deck is built." });
    expect(read(c.bubbles())).toEqual([
      "On it.\n\nDone: the deck is built.",
      "steps: Ran 3 commands, wrote a file",
    ]);
    const steps = c.bubbles().find((bubble) => bubble.kind === "steps");
    expect(steps?.kind === "steps" && steps.steps.map((one) => one.line)).toEqual([
      "Ran a command",
      "Ran a command",
      "Wrote a file",
      "Ran a command",
    ]);
  });

  test("a step that failed says so in the line", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.step("r1", "", [
      ["a", "web_search"],
      ["b", "web_search"],
      ["c", "workspace_read", true],
    ]);
    c.stored({ type: "reply_finished", reply: "r1", text: "Here." });
    expect(read(c.bubbles())).toContain("steps: Searched the web twice, couldn't read a file");
  });

  test("past three kinds of step the line counts the rest", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.step("r1", "", [
      ["a", "shell"],
      ["b", "workspace_read"],
      ["c", "workspace_read"],
      ["d", "web_fetch"],
      ["e", "memory_save"],
      ["f", "todo"],
    ]);
    c.stored({ type: "reply_finished", reply: "r1", text: "Here." });
    expect(read(c.bubbles())).toContain(
      "steps: Ran a command, read 2 files, read a web page and 2 more",
    );
  });

  test("a call still running is the working line's, not a step yet", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Looking.",
      calls: [{ id: "a", name: "shell", arguments: {} }],
    });
    expect(read(c.bubbles())).toEqual(["Looking."]);
  });

  test("a request the person answered stays a card while the reply runs, then folds into its steps", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Drafted it.",
      calls: [{ id: "k9", name: "send_email", arguments: {} }],
    });
    c.stored({ type: "approval_requested", reply: "r1", call_id: "k9", name: "send_email" });
    c.stored({ type: "approval_answered", reply: "r1", call_id: "k9", allowed: true });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "k9",
      name: "send_email",
      content: "",
      is_error: false,
    });
    // The steps line sits under the words, above the card, as the card sits under the step.
    expect(read(c.bubbles())).toEqual(["Drafted it.", "steps: Sent an email", "ask allowed"]);
    c.stored({ type: "reply_finished", reply: "r1", text: "Sent." });
    expect(read(c.bubbles())).toEqual(["Drafted it.\n\nSent.", "steps: Sent an email"]);
  });

  test("a card, a helper or a skill the bot offered is never also a step", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.step("r1", "", [
      ["a", "ask_user"],
      ["b", "helper"],
      ["c", "skill_propose"],
    ]);
    c.stored({ type: "reply_finished", reply: "r1", text: "Over to you." });
    expect(read(c.bubbles()).some((line) => line.startsWith("steps"))).toBe(false);
  });

  test("a step lands under the reply it names, even after another reply has begun", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Checking.",
      calls: [{ id: "a", name: "shell", arguments: {} }],
    });
    // A routine's reply begins before the first one's call reports back.
    c.stored({ type: "reply_started", reply: "r2" });
    c.stored({ type: "step_finished", reply: "r2", text: "Morning.", calls: [] });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "a",
      name: "shell",
      content: "",
      is_error: false,
    });
    c.stored({ type: "reply_finished", reply: "r2", text: "Morning." });
    expect(read(c.bubbles())).toEqual(["Checking.", "steps: Ran a command", "Morning."]);
    const steps = c.bubbles().find((bubble) => bubble.kind === "steps");
    expect(steps?.kind === "steps" && steps.reply).toBe("r1");
  });

  test("a step finishing after the person steered stays with the words that took it", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Reading the logs.",
      calls: [{ id: "a", name: "workspace_read", arguments: {} }],
    });
    c.stored({ type: "user_message", text: "Only the Linux run" });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "a",
      name: "workspace_read",
      content: "",
      is_error: false,
    });
    c.stored({ type: "reply_finished", reply: "r1", text: "Linux fails on the timer." });
    expect(read(c.bubbles())).toEqual([
      "Reading the logs.",
      "steps: Read a file",
      "person",
      "Linux fails on the timer.",
    ]);
  });

  test("Try again stays on a failed reply that took steps", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Check CI" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.step("r1", "", [["a", "shell"]]);
    c.stored({
      type: "reply_failed",
      reply: "r1",
      text: "",
      error: "429",
      kind: "rate_limited",
      endpoint: "openrouter",
    });
    const failed = c.bubbles().find((bubble) => bubble.kind === "bot");
    expect(failed?.kind === "bot" && failed.failure?.retry).toBe("Check CI");
  });
});

/**
 * r1 ran a command (started at seq 3, done at 5) and asked to send an email, which the person
 * declined (6), so it never started: the log files it at its result (7).
 */
const worked = () => {
  const c = conversation();
  c.stored({ type: "reply_started", reply: "r1" });
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: [
      { id: "a", name: "shell", arguments: {} },
      { id: "b", name: "send_email", arguments: {} },
    ],
  });
  c.stored({ type: "tool_started", reply: "r1", call_id: "a", name: "shell" });
  c.stored({ type: "approval_requested", reply: "r1", call_id: "b", name: "send_email" });
  c.stored({
    type: "tool_finished",
    reply: "r1",
    call_id: "a",
    name: "shell",
    content: "",
    is_error: false,
  });
  c.stored({ type: "approval_answered", reply: "r1", call_id: "b", allowed: false });
  c.stored({
    type: "tool_finished",
    reply: "r1",
    call_id: "b",
    name: "send_email",
    content: "The person declined this action.",
    is_error: true,
  });
  c.stored({ type: "reply_finished", reply: "r1", text: "Done." });
  const steps = c.bubbles().find((bubble) => bubble.kind === "steps");
  if (steps?.kind !== "steps") throw new Error("no steps");
  return steps.steps;
};
// As Spade's activity log answers, newest first: each call filed at the event that logged it.
const log = parseSpadeActivity(
  JSON.stringify({
    entries: [
      {
        id: "8-0",
        seq: 8,
        kind: "spend",
        sentence: "Finished · 2 steps",
        summary: "2 steps",
      },
      {
        id: "7-0",
        seq: 7,
        kind: "tool",
        name: "send_email",
        summary: "to: marta@example.com",
        sentence: "You declined: send an email",
        detail: "To Marta · Plan",
        outcome: "declined",
        reply: "r1",
      },
      {
        id: "3-0",
        seq: 3,
        kind: "tool",
        name: "shell",
        summary: "gh pr list",
        sentence: "Ran a command",
        detail: "gh pr list --state open",
        outcome: "ok",
        reply: "r1",
      },
    ],
    more: false,
  }),
);

describe("a reply's steps in Spade's words", () => {
  test("each step takes its sentence and one line of detail from the activity log", () => {
    const steps = spadeStepsWithActivity(worked(), log?.entries ?? []);
    expect(steps.map((step) => [step.line, step.detail])).toEqual([
      ["Ran a command", "gh pr list --state open"],
      ["You declined: send an email", "To Marta · Plan"],
    ]);
  });

  test("a step the log doesn't have keeps its own words", () => {
    const steps = spadeStepsWithActivity(worked(), []);
    expect(steps.map((step) => [step.line, step.detail])).toEqual([
      ["Ran a command", undefined],
      ["You declined: send an email", undefined],
    ]);
  });

  test("the log is asked only for the calls' kinds, back from just after the newest", () => {
    expect(spadeStepsQuery(worked())).toEqual({
      kinds: ["tool", "connector", "file"],
      before: 8,
      limit: 10,
    });
  });
});
