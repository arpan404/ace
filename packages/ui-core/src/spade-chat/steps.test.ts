import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
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
